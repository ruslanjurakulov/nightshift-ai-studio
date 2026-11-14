-- 0166_films_core.sql — Film Studio P1: the film, its storyboard and its audit trail, as drafts only.
--
-- A person describes a film; it is split into scenes (10 or more, up to 60); each scene is shot later as 1-3 AI video shots that chain
-- from the previous shot's last frame, and the shots are assembled into one video. THIS FILE IS ONLY THE DRAFT: the tables, who may
-- read them, and the three calls a browser may make (create a draft, edit its storyboard, read it). docs/FILM_STUDIO.md has the plan.
--
-- NOTHING HERE SPENDS, HOLDS, QUEUES OR CALLS A PROVIDER. No credit function is called, no creative job or render job is created, no
-- model is invoked. A film created here stays `draft` until a later migration (0167, P2: quote, start, the funding segment) adds a way
-- forward, and the storyboard is the only thing that changes. There is no publish path at all (rule 2 is untouched).
--
-- WHAT IT ADDS (no existing table, column, policy, constraint, row or function body is touched)
--   films          one film of an organization: what it is from (a topic or a script), its format (language, aspect, length), its look
--                  (style kit, key-frame and clip models), its sound settings, its status and a version bumped on every edit.
--   film_scenes    the storyboard: up to 60 ordered scenes, each with its narration, visual prompt, planned length (3-30 s), how many
--                  clip shots (1-3) and how its FIRST and LAST frames are obtained (below).
--   film_refs      the reference set: characters, style and location pictures, for the whole film or for one scene.
--   film_takes     the version history: one row per generated artifact (key frame, clip, extend, narration, captions), with each
--                  input frame recorded by its role. Nothing writes it in this file; the orchestrator does (P3).
--   film_events    append-only: every state-changing call writes one row of who (auth uid and their role) did what.
--   create_film_draft, save_film, archive_film, film_json   the browser's calls (below). Everything else is internal.
--
-- FRAME ROLES (the vendors take three different kinds of picture, and the schema keeps them apart)
--   first_frame  the picture a clip starts from. Per scene: `keyframe` (generate a key frame from the prompt and the references),
--                `asset` (a picture from the organization's library) or `previous` (continue from the previous scene's last frame;
--                never on the first scene).
--   last_frame   the picture a clip must end on, for models that take one (MiniMax H3, Kling v3). Per scene: `none`, `asset`, or
--                `next_keyframe` (end on the next scene's key frame: never on the last scene, and only when the next scene has a key
--                frame of its own, i.e. does not continue from this one). A vendor that takes a last frame always needs a first frame
--                with it, so a take with a last frame and no first frame is refused by the table itself.
--   reference    character, style and location pictures (film_refs). On MiniMax H3 and Seedance 2.x a task takes EITHER frames OR
--                references, never both, so the references reach a clip through its key frame; which model can take what is checked
--                against the registry when a film is quoted (P2), not here.
--
-- MODELS. A key-frame model (t2i or edit) or a clip model (i2v) a person picks must be on sale on the web right now
--   (sellable_models: verified by a real probe, priced, terms clear, not switched off, not past shutdown). A model that was already
--   saved is not re-checked on every edit (a title change must not fail because a model went off sale since); the quote checks every
--   model again before anything is held. No Seedance model (BytePlus, provider `bytedance`) is ever accepted, whatever the registry
--   says: BytePlus's service terms §4.2.3 forbid re-integrating its video API into an AI content-creation tool, and a written consent
--   does not plainly lift that (docs/research, Scout 2026-11-14). The refusal is `model_not_offered`.
--
-- LIMITS (film_limits() is the one list; the table checks repeat the same numbers so any writer is held to them)
--   60 scenes a film · 3-30 s a scene · 1-3 clip shots a scene · 1200 s of planned scenes in total · a target of 60-1200 s ·
--   a topic of 2,000 or a script of 40,000 characters · 16 film-wide references and 8 per scene · 50 open drafts and 500 films in
--   all (archived ones included) an organization · 5,000 recorded changes a film · a title of 120, a narration or visual prompt of 2,000, a negative prompt of 1,000 characters. Text is cleaned by film_clean_text
--   (0131's ads_clean_text under this file's name): control, zero-width, direction and tag characters are removed, because visual
--   prompts are handed to a model later and an invisible character is a hidden-instruction channel.
--   RATE (in the database, because the RPCs are reachable through PostgREST without the Command Center): per person per hour,
--   30 creates, 240 saves, 60 archives (take_web_rate under `db.film.*`; NS429 rate_limited). Together with the caps above this bounds
--   what a scripted editor can store; erasure is the operator's (docs/FILM_STUDIO.md, "Storage and erasure").
--
-- WHO MAY DO WHAT ("editor" is the role that may change work in 0018's ladder; viewers read)
--   films, film_scenes, film_refs, film_takes, film_events
--       select: members of the organization, of the columns this file names (column grants; never the request hash) · no insert /
--       update / delete for anyone, the service key included (it bypasses RLS, not privileges): the functions below are the only
--       write path. The service key reads whole rows.
--   create_film_draft, save_film, archive_film     editors and above
--   film_json                                      any member
--   anon gets nothing. The helpers are executable by no API role. Another organization's film reads exactly like one that does not
--   exist (P0002 not_found).
--
-- EDITING. save_film(film, version, patch) changes a film whose status is `draft` or `planned` (film_is_editable) and nothing else:
--   once a film has started, it is refused (NS409 film_not_editable). The version must be the film's current one (NS409 film_changed),
--   and the row is locked, so two saves of the same version make one edit and one refusal. A patch carries any of the settings, and
--   `scenes` (the whole ordered list: a scene with an `id` keeps it and its unspecified fields, one without is new, one left out is
--   deleted) and `refs` (the whole film-wide list). A scene that already has takes cannot be deleted (NS409 scene_has_takes).
--
-- IDEMPOTENCY. create_film_draft takes the caller's idempotency key: the same key with the same request answers the film it made, with
--   no second film and no second event; the same key with a different request is NS409 idempotency_conflict.
--
-- ERRORS (SQLSTATE; the message is the machine code the app maps; detail says which field, in our own words)
--   42501 forbidden · P0002 not_found
--   NS400 invalid_params | invalid_idempotency_key | limit_reached | model_not_offered | model_not_available | asset_not_usable
--   NS409 film_changed | film_not_editable | idempotency_conflict | scene_has_takes
--   NS429 rate_limited
--
-- LATER MIGRATIONS (docs/FILM_STUDIO.md): money and the funding segment (0167: film_segments, the money columns on film_takes,
--   creative_jobs.film_take_id), assembly (0168: film_cuts, films.current_cut_id), re-shoot (0169), the channel handoff (0170) and the
--   autopilot link (0171: films.storyboard_id). A column arrives with the migration whose code writes it.
--
-- REQUIRES 0018 (organizations), 0036 (creative_refuse, creative_json_int, creative_jobs), 0038 (media_assets), 0047 (style kits and
-- characters), 0042/0087 (take_web_rate) and 0125 (sellable_models). Additive and idempotent: guarded creates, drop-then-
-- create checks and policies, create-or-replace functions of this file's own names, each refused if it is not this file's body.
--
-- Rollback: docs/sql/rollback_0166_films_core.sql (refuses while any film exists unless its override line is set).

set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null
     or to_regprocedure('public.accessible_org_ids(text)') is null
     or to_regprocedure('public.org_role(uuid)') is null
     or to_regprocedure('public.channel_org(text)') is null then
    raise exception '0166 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.creative_refuse(text, text, text)') is null
     or to_regprocedure('public.creative_json_int(jsonb, numeric, numeric)') is null
     or to_regclass('public.creative_jobs') is null then
    raise exception '0166 needs the creative jobs: apply 0036_creative_jobs.sql first';
  end if;
  if to_regclass('public.media_assets') is null then
    raise exception '0166 needs 0038_media_assets.sql: apply it first';
  end if;
  if to_regclass('public.style_kits') is null or to_regclass('public.characters') is null then
    raise exception '0166 needs 0047_style_kits_characters.sql: apply it first';
  end if;
  if to_regprocedure('public.take_web_rate(text, integer, integer)') is null then
    raise exception '0166 needs take_web_rate: apply 0042_web_api_hardening.sql (and 0087) first';
  end if;
  if to_regprocedure('public.sellable_models(text, text)') is null then
    raise exception '0166 needs sellable_models (0035, as 0125 left it): apply them first';
  end if;
  -- The tables this file creates: absent, or this file's own (create table if not exists would otherwise skip a stranger's table of
  -- the same name, and every statement below would then apply to it).
  for r in select * from (values ('films', 'source_kind'), ('film_scenes', 'first_frame'), ('film_refs', 'character_id'),
                                 ('film_takes', 'result_last_frame_asset_id'), ('film_events', 'actor_role')) v(t, c) loop
    if to_regclass('public.' || r.t) is not null
       and not exists (select 1 from information_schema.columns
                        where table_schema = 'public' and table_name = r.t and column_name = r.c) then
      raise exception '0166 found a table public.% that is not this file''s (no column %): read it first', r.t, r.c;
    end if;
  end loop;
  -- The functions this file creates: absent, or this file's own bodies (a replay).
  for r in select * from (values
      ('public.film_clean_text(text, boolean)', 'eb0cb2be33ffcb6213e858d445863bb2'),
      ('public.film_text_ok(text, integer, integer, boolean)', '52994765248e75d72c40c690113819ce'),
      ('public.film_limits()', '9ddbb45ad45efa76265b4f1b22c048bb'),
      ('public.film_is_editable(text)', 'c0acbafd8953f6392bbccfbf6e23dd59'),
      ('public.film_events_append_only()', '108390766c4445caffdef16883a1c02b'),
      ('public.film_log(uuid, uuid, uuid, text, jsonb)', 'a3b4cc07b7d530afb27f02df3e2e8239'),
      ('public.film_uuid(jsonb, text)', '51707e246a03b38cc002f3f495053aa2'),
      ('public.film_text(jsonb, text, integer, integer, boolean)', 'bd1a548e5a7306fa23a563c49896b026'),
      ('public.film_asset_live(uuid, uuid, text)', '6e051a883f2a62f8799ce19c297b80c0'),
      ('public.film_check_asset(uuid, jsonb, text, text)', 'f83fc47b93a3fb95dfe74a4c9f616e97'),
      ('public.film_check_model(text, text[], text)', '864da632969ae05f964eee1b568a671f'),
      ('public.film_apply_settings(public.films, jsonb, text[])', '248ffb76f60f3a6f4e8b34b85cd0c92b'),
      ('public.film_save_refs(public.films, uuid, jsonb, integer, text)', '6627ca1abe649f0b885c67d126cd10cd'),
      ('public.film_save_scenes(public.films, jsonb)', 'c836631256f669318c9ef499d7c4c54b'),
      ('public.film_check_storyboard(public.films)', '00d22e9f962865d66a11bce77d6d54bf'),
      ('public.film_take_rate(text, integer)', '79b149bec3ade73e701caed809fd4f64'),
      ('public.film_ref_json(public.film_refs)', '3774a60dcbd400928b4698f9c7e73f17'),
      ('public.film_take_json(public.film_takes)', 'c0b977a301577d57a137a77f9ea0040f'),
      ('public.film_read(uuid)', '92f02292981b366f817bd37881e20a0f'),
      ('public.film_json(uuid)', '8056afd0fba0f3431c9f5c9105869bc5'),
      ('public.create_film_draft(uuid, text, text, text, jsonb, text)', '70de05015b8680fb82a9f2ca1763b11b'),
      ('public.save_film(uuid, integer, jsonb)', 'f13523910eb7c9084052ba5fdcc899a6'),
      ('public.archive_film(uuid)', '9ca4e793fd81bbd4a0aecdebd59d6dc6')) v(sig, want) loop
    -- (Before PostgreSQL 16, to_regprocedure raises for an argument type that does not exist instead of answering NULL.)
    if (r.sig like '%public.films%' and to_regtype('public.films') is null)
       or (r.sig like '%public.film\_refs%' and to_regtype('public.film_refs') is null)
       or (r.sig like '%public.film\_takes%' and to_regtype('public.film_takes') is null) then
      continue;  -- a fresh database: the type the signature names does not exist yet, so neither can the function
    end if;
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is not null and h <> r.want then
      raise exception '0166 found % with a body that is not this file''s (md5 %): read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 0. Text helpers (before the tables: their checks use them)
-- ───────────────────────────────────────────────────────────────────────────

-- Text a person typed, made storable: 0131's ads_clean_text and ads_text_ok, byte for byte under Film Studio's own names
-- (tests/test_films_core_migration.py pins that the two pairs stay identical). Own copies, not calls: rollback_0131 drops 0131's,
-- and a film table whose checks named them would block that rollback, while a function body that called them would break every
-- film call after it. Removed: control characters and every character nobody sees (zero-width, direction marks and overrides,
-- invisible operators, variation selectors, the Unicode tag block, ...): a visual prompt is handed to a video model later, and an
-- invisible character is a hidden-instruction channel to it. A single-line field reads line breaks and tabs as one space; a
-- multi-line field keeps its line breaks (\r\n folded to \n). Blank-looking spaces are spaces, a run of them reads as one, and the
-- text is trimmed.
create or replace function public.film_clean_text(p_text text, p_multiline boolean) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select btrim(regexp_replace(regexp_replace(
           case when p_multiline
                then regexp_replace(coalesce(p_text, ''), '\r\n?', E'\n', 'g')
                else regexp_replace(coalesce(p_text, ''), '[\x09-\x0d\u2028\u2029]+', ' ', 'g') end,
           case when p_multiline
                then '[\x01-\x09\x0b-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]'
                else '[\x01-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]' end,
           '', 'g'),
           '[ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+', ' ', 'g'), E' \n')
$$;

-- The same rule as a yes/no, for the table checks: the text is already clean and within its length.
create or replace function public.film_text_ok(p_text text, p_min integer, p_max integer, p_multiline boolean) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_text is not null
     and char_length(p_text) between p_min and p_max
     and p_text = btrim(p_text, E' \n')
     and p_text !~ (case when p_multiline
                         then '[\x01-\x09\x0b-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]'
                         else '[\x01-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]' end)
     and p_text !~ '[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]'
     and position('  ' in p_text) = 0
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

-- Every foreign key to media_assets is NO ACTION on purpose: a library file is soft-deleted (deleted_at), never hard-deleted, so
-- nothing ever cascades or nulls a film's picture behind a person's back; a file that was deleted reads as `missing` in film_json.
-- (Hard deletes happen only when an organization is deleted, which films_org restrict already refuses while it has films.) Each of
-- these columns has a partial index, so the check on the rare hard delete never scans a film table.

create table if not exists public.films (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete restrict,
  -- NULL: a Studio film of the organization, not yet meant for a channel. Set: a channel of the same organization (checked by the
  -- functions; channels are never deleted).
  channel_id         text references public.channels (channel_id) on delete restrict,
  title              text not null,
  source_kind        text not null,
  source_text        text not null default '',
  language           text not null,
  aspect             text not null default '16:9',
  target_seconds     integer not null,
  resolution         text,
  -- No foreign key on purpose: an editor may delete a style kit (0047, a direct delete), and a restrict would break that, while a
  -- set-null would change a film's look without anyone deciding it. A kit that no longer exists reads as missing in film_json, and
  -- the quote refuses it.
  style_kit_id       uuid,
  keyframe_model     text,
  clip_model         text,
  voice              jsonb,
  music_asset_id     uuid references public.media_assets (id),
  music_gain_db      numeric(4,1),
  duck_db            numeric(4,1),
  captions_mode      text not null default 'sidecar',
  transition_default text not null default 'cut',
  status             text not null default 'draft',
  pause_reason       text,
  pause_detail       text,
  version            integer not null default 1,
  idempotency_key    text not null,
  request_hash       text not null,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  archived_at        timestamptz
);

-- One constraint per concern, so a later migration replaces the one it changes (0167 a status, say) and nothing else.
alter table public.films drop constraint if exists films_check;
alter table public.films drop constraint if exists films_text_check;
alter table public.films add constraint films_text_check
  check (public.film_text_ok(title, 1, 120, false)
         and source_kind in ('topic', 'script', 'storyboard')
         and public.film_text_ok(source_text, 0, 40000, true)
         and (source_kind <> 'topic' or char_length(source_text) <= 2000));
alter table public.films drop constraint if exists films_format_check;
alter table public.films add constraint films_format_check
  check (language in ('en', 'ru', 'uz')
         and aspect in ('16:9', '9:16', '1:1')
         and target_seconds between 60 and 1200
         and (resolution is null or resolution in ('480p', '720p', '768p', '1080p', '2k', '4k')));
alter table public.films drop constraint if exists films_models_check;
alter table public.films add constraint films_models_check
  check ((keyframe_model is null or keyframe_model ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
         and (clip_model is null or clip_model ~ '^[a-z0-9][a-z0-9._-]{0,63}$'));
alter table public.films drop constraint if exists films_sound_check;
alter table public.films add constraint films_sound_check
  check ((voice is null or (jsonb_typeof(voice) = 'object' and octet_length(voice::text) <= 512))
         and (music_gain_db is null or music_gain_db between -40 and 0)
         and (duck_db is null or duck_db between -40 and 0)
         and captions_mode in ('sidecar', 'burn', 'both', 'none')
         and transition_default in ('cut', 'dip_to_black', 'crossfade'));
alter table public.films drop constraint if exists films_status_check;
alter table public.films add constraint films_status_check
  check (status in ('draft', 'planning', 'planned', 'running', 'draining', 'paused', 'assembling', 'ready',
                    'failed', 'cancelled', 'archived')
         and (pause_reason is null or pause_reason ~ '^[a-z][a-z0-9_]{0,63}$')
         and (pause_detail is null or public.film_text_ok(pause_detail, 1, 500, false))
         and ((status = 'archived') = (archived_at is not null)));
alter table public.films drop constraint if exists films_bookkeeping_check;
alter table public.films add constraint films_bookkeeping_check
  check (version >= 1
         and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$'
         and request_hash ~ '^[0-9a-f]{32}$');

-- The film and its organization together: every child table references the pair, so a scene, a reference, a take or an event can
-- never name another organization's film.
create unique index if not exists films_id_org_key on public.films (id, org_id);
create unique index if not exists films_org_idempotency_key on public.films (org_id, idempotency_key);
create index if not exists films_org_idx on public.films (org_id, updated_at desc) where archived_at is null;
create index if not exists films_channel_idx on public.films (channel_id) where channel_id is not null;
create index if not exists films_music_asset_idx on public.films (music_asset_id) where music_asset_id is not null;

comment on table public.films is
  'Film Studio films (migration 0166). Written only by create_film_draft / save_film / archive_film (and the later Film Studio functions); read by members of the organization.';

create table if not exists public.film_scenes (
  id                   uuid primary key default gen_random_uuid(),
  film_id              uuid not null,
  org_id               uuid not null,
  position             smallint not null,
  title                text not null default '',
  narration            text not null default '',
  visual_prompt        text not null default '',
  negative_prompt      text not null default '',
  planned_seconds      integer not null,
  shot_count           smallint not null default 1,
  first_frame          text not null default 'keyframe',
  first_frame_asset_id uuid references public.media_assets (id),
  last_frame           text not null default 'none',
  last_frame_asset_id  uuid references public.media_assets (id),
  -- NULL: the film's model.
  keyframe_model       text,
  clip_model           text,
  clip_params          jsonb not null default '{}'::jsonb,
  -- NULL: the film's transition.
  transition_in        text,
  -- NULL until a take of this scene is chosen: "never shot" is not version 0 of anything.
  current_version      integer,
  status               text not null default 'draft',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint film_scenes_film_fk
    foreign key (film_id, org_id) references public.films (id, org_id) on delete restrict
);

alter table public.film_scenes drop constraint if exists film_scenes_check;
alter table public.film_scenes drop constraint if exists film_scenes_text_check;
alter table public.film_scenes add constraint film_scenes_text_check
  check (public.film_text_ok(title, 0, 120, false)
         and public.film_text_ok(narration, 0, 2000, true)
         and public.film_text_ok(visual_prompt, 0, 2000, true)
         and public.film_text_ok(negative_prompt, 0, 1000, true));
alter table public.film_scenes drop constraint if exists film_scenes_shape_check;
alter table public.film_scenes add constraint film_scenes_shape_check
  check (position between 0 and 59
         and planned_seconds between 3 and 30
         and shot_count between 1 and 3
         and jsonb_typeof(clip_params) = 'object' and octet_length(clip_params::text) <= 512
         and (transition_in is null or transition_in in ('cut', 'dip_to_black', 'crossfade')));
alter table public.film_scenes drop constraint if exists film_scenes_frames_check;
alter table public.film_scenes add constraint film_scenes_frames_check
  check (first_frame in ('keyframe', 'asset', 'previous')
         and ((first_frame = 'asset') = (first_frame_asset_id is not null))
         and not (position = 0 and first_frame = 'previous')
         and last_frame in ('none', 'asset', 'next_keyframe')
         and ((last_frame = 'asset') = (last_frame_asset_id is not null)));
alter table public.film_scenes drop constraint if exists film_scenes_models_check;
alter table public.film_scenes add constraint film_scenes_models_check
  check ((keyframe_model is null or keyframe_model ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
         and (clip_model is null or clip_model ~ '^[a-z0-9][a-z0-9._-]{0,63}$'));
alter table public.film_scenes drop constraint if exists film_scenes_status_check;
alter table public.film_scenes add constraint film_scenes_status_check
  check ((current_version is null or current_version >= 1)
         and status in ('draft', 'queued', 'generating', 'ready', 'failed'));

create unique index if not exists film_scenes_id_film_key on public.film_scenes (id, film_id);
create index if not exists film_scenes_org_idx on public.film_scenes (org_id, film_id);
create index if not exists film_scenes_first_frame_idx on public.film_scenes (first_frame_asset_id) where first_frame_asset_id is not null;
create index if not exists film_scenes_last_frame_idx on public.film_scenes (last_frame_asset_id) where last_frame_asset_id is not null;
-- Deferrable, so a reorder can move scenes through each other's positions inside one save and be checked once at the end.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.film_scenes'::regclass and conname = 'film_scenes_position_key') then
    alter table public.film_scenes add constraint film_scenes_position_key
      unique (film_id, position) deferrable initially immediate;
  end if;
end $$;

comment on table public.film_scenes is
  'The storyboard of a film (migration 0166): up to 60 ordered scenes with their narration, prompt, planned length, shots and frame roles. Written only by save_film (and the later Film Studio functions).';

create table if not exists public.film_refs (
  id           uuid primary key default gen_random_uuid(),
  film_id      uuid not null,
  org_id       uuid not null,
  -- NULL: the whole film. Set: this scene only (and deleted with it).
  scene_id     uuid,
  kind         text not null,
  -- No foreign key on purpose (as films.style_kit_id): an editor may delete a character directly (0047). A character that no
  -- longer exists reads as missing in film_json, and the quote refuses it.
  character_id uuid,
  asset_id     uuid references public.media_assets (id),
  position     smallint not null,
  created_at   timestamptz not null default now(),
  constraint film_refs_film_fk
    foreign key (film_id, org_id) references public.films (id, org_id) on delete restrict,
  constraint film_refs_scene_fk
    foreign key (scene_id, film_id) references public.film_scenes (id, film_id) on delete cascade
);

alter table public.film_refs drop constraint if exists film_refs_check;
alter table public.film_refs add constraint film_refs_check
  check (kind in ('character', 'style', 'location')
         and ((character_id is null) <> (asset_id is null))
         and (character_id is null or kind = 'character')
         and position between 0 and 15
         and (scene_id is null or position between 0 and 7));

create unique index if not exists film_refs_position_key
  on public.film_refs (film_id, coalesce(scene_id, '00000000-0000-0000-0000-000000000000'::uuid), position);
create index if not exists film_refs_org_idx on public.film_refs (org_id, film_id);
-- film_read reads each scene's references by scene: without this it scans every reference of every film.
create index if not exists film_refs_scene_idx on public.film_refs (scene_id, position) where scene_id is not null;
create index if not exists film_refs_asset_idx on public.film_refs (asset_id) where asset_id is not null;

comment on table public.film_refs is
  'The reference set of a film (migration 0166): characters, style and location pictures for the whole film (16) or one scene (8). Written only by save_film.';

create table if not exists public.film_takes (
  id                         uuid primary key default gen_random_uuid(),
  film_id                    uuid not null,
  org_id                     uuid not null,
  -- NULL for the film-level takes (narration, captions).
  scene_id                   uuid,
  version                    integer not null,
  -- 0: the key frame (or a film-level take); 1: the first clip shot; 2-3: extends from the previous shot's last frame.
  shot_index                 smallint not null,
  kind                       text not null,
  -- An extend points to the shot it continues; a re-shoot to the take it replaces.
  parent_take_id             uuid references public.film_takes (id),
  attempt                    smallint not null default 1,
  status                     text not null default 'planned',
  model                      text,
  -- What was actually sent, after the references and the style were composed in.
  prompt_final               text,
  params                     jsonb not null default '{}'::jsonb,
  duration_s                 numeric(6,2),
  -- The input pictures by the role the vendor gives them (see the header).
  first_frame_asset_id       uuid references public.media_assets (id),
  last_frame_asset_id        uuid references public.media_assets (id),
  reference_asset_ids        uuid[] not null default '{}'::uuid[],
  reshoot                    jsonb,
  creative_job_id            uuid references public.creative_jobs (id),
  result_asset_id            uuid references public.media_assets (id),
  -- The last frame extracted from this take's own output: the first frame of the next extend.
  result_last_frame_asset_id uuid references public.media_assets (id),
  error_code                 text,
  error                      text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  finished_at                timestamptz,
  constraint film_takes_film_fk
    foreign key (film_id, org_id) references public.films (id, org_id) on delete restrict,
  constraint film_takes_scene_fk
    foreign key (scene_id, film_id) references public.film_scenes (id, film_id) on delete restrict
);

alter table public.film_takes drop constraint if exists film_takes_check;
alter table public.film_takes drop constraint if exists film_takes_slot_check;
alter table public.film_takes add constraint film_takes_slot_check
  check (version >= 1
         and kind in ('keyframe', 'clip', 'extend', 'narration', 'captions')
         and ((kind in ('narration', 'captions')) = (scene_id is null))
         and ((kind in ('keyframe', 'narration', 'captions') and shot_index = 0)
              or (kind = 'clip' and shot_index = 1)
              or (kind = 'extend' and shot_index between 2 and 3))
         and attempt between 1 and 2);
alter table public.film_takes drop constraint if exists film_takes_status_check;
alter table public.film_takes add constraint film_takes_status_check
  check (status in ('planned', 'queued', 'running', 'completed', 'failed', 'skipped', 'superseded')
         and (error_code is null or error_code ~ '^[a-z0-9_]{1,64}$')
         and (error is null or char_length(error) <= 2000));
alter table public.film_takes drop constraint if exists film_takes_request_check;
alter table public.film_takes add constraint film_takes_request_check
  check ((model is null or model ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
         and (prompt_final is null or char_length(prompt_final) <= 8000)
         and jsonb_typeof(params) = 'object' and octet_length(params::text) <= 8192
         and (duration_s is null or (duration_s > 0 and duration_s <= 60))
         and (reshoot is null or (jsonb_typeof(reshoot) = 'object' and octet_length(reshoot::text) <= 2048)));
alter table public.film_takes drop constraint if exists film_takes_frames_check;
alter table public.film_takes add constraint film_takes_frames_check
  -- Every vendor that takes a last frame takes it only together with a first frame.
  check ((last_frame_asset_id is null or first_frame_asset_id is not null)
         and cardinality(reference_asset_ids) <= 16
         and array_position(reference_asset_ids, null) is null);

create unique index if not exists film_takes_slot_key
  on public.film_takes (film_id, coalesce(scene_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, version, shot_index, attempt);
-- One creative job makes at most one take, ever.
create unique index if not exists film_takes_job_key on public.film_takes (creative_job_id) where creative_job_id is not null;
create index if not exists film_takes_org_idx on public.film_takes (org_id, film_id);
create index if not exists film_takes_scene_idx on public.film_takes (scene_id, version) where scene_id is not null;
create index if not exists film_takes_parent_idx on public.film_takes (parent_take_id) where parent_take_id is not null;
create index if not exists film_takes_first_frame_idx on public.film_takes (first_frame_asset_id) where first_frame_asset_id is not null;
create index if not exists film_takes_last_frame_idx on public.film_takes (last_frame_asset_id) where last_frame_asset_id is not null;
create index if not exists film_takes_result_idx on public.film_takes (result_asset_id) where result_asset_id is not null;
create index if not exists film_takes_result_last_frame_idx
  on public.film_takes (result_last_frame_asset_id) where result_last_frame_asset_id is not null;

comment on table public.film_takes is
  'The version history of a film (migration 0166): one row per generated key frame, clip, extend, narration or captions, with its input frames by role. Written only by the Film Studio orchestrator functions (later migrations); nothing in 0166 writes it.';

create table if not exists public.film_events (
  id         bigint generated always as identity primary key,
  film_id    uuid not null,
  org_id     uuid not null,
  -- No foreign key: the history of a scene must outlive the scene.
  scene_id   uuid,
  -- auth.uid() of the person, or NULL for a service writer (later migrations); actor_role says which.
  actor      uuid,
  actor_role text not null,
  event      text not null,
  detail     jsonb,
  created_at timestamptz not null default now(),
  constraint film_events_film_fk
    foreign key (film_id, org_id) references public.films (id, org_id) on delete restrict
);

alter table public.film_events drop constraint if exists film_events_check;
alter table public.film_events add constraint film_events_check
  check (event ~ '^[a-z][a-z_]{0,39}$'
         and actor_role in ('owner', 'admin', 'editor', 'viewer', 'service')
         and ((actor_role = 'service') = (actor is null))
         and (detail is null or (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 4096)));

create index if not exists film_events_film_idx on public.film_events (film_id, id);
create index if not exists film_events_org_idx on public.film_events (org_id, id);

comment on table public.film_events is
  'Append-only audit trail of Film Studio (migration 0166): one row per state-changing call, with who (auth uid, role) did what. Nobody may update or delete a row.';

create or replace function public.film_events_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'film_events is append-only' using errcode = '42501';
end
$$;

drop trigger if exists film_events_append_only on public.film_events;
create trigger film_events_append_only
  before update or delete on public.film_events
  for each row execute function public.film_events_append_only();

drop trigger if exists film_events_no_truncate on public.film_events;
create trigger film_events_no_truncate
  before truncate on public.film_events
  for each statement execute function public.film_events_append_only();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- The limits, once. The functions enforce these numbers and film_json hands them to the app, so the UI never keeps a second copy;
-- the table checks repeat them (tests/test_films_core_migration.py pins that the two agree).
create or replace function public.film_limits() returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'max_scenes', 60, 'scene_seconds_min', 3, 'scene_seconds_max', 30, 'max_shots', 3,
    'max_film_seconds', 1200, 'target_seconds_min', 60, 'target_seconds_max', 1200,
    'max_topic_chars', 2000, 'max_script_chars', 40000, 'max_title_chars', 120,
    'max_narration_chars', 2000, 'max_prompt_chars', 2000, 'max_negative_chars', 1000,
    'max_film_refs', 16, 'max_scene_refs', 8, 'max_open_drafts', 50, 'max_patch_bytes', 2000000,
    'max_films_total', 500, 'max_events_per_film', 5000,
    'creates_per_hour', 30, 'saves_per_hour', 240, 'archives_per_hour', 60)
$$;

-- Which statuses a person may still edit. One place, so the migration that adds pause-and-edit (P2) replaces one function.
create or replace function public.film_is_editable(p_status text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_status in ('draft', 'planned')
$$;

-- One audit row. The role is the caller's role in the film's organization at the moment of the call. A signed-in caller with no
-- role there is refused, never recorded as a viewer: an audit row that names the wrong role is worse than no write at all.
create or replace function public.film_log(p_film uuid, p_org uuid, p_scene uuid, p_event text, p_detail jsonb default null)
  returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid  uuid := auth.uid();
  role text;
begin
  if uid is null then
    role := 'service';
  else
    role := public.org_role(p_org);
    if role is null then
      raise exception 'forbidden' using errcode = '42501', detail = 'film_log: the caller has no role in this organization';
    end if;
  end if;
  insert into public.film_events (film_id, org_id, scene_id, actor, actor_role, event, detail)
  values (p_film, p_org, p_scene, uid, role, p_event, p_detail);
end
$$;

-- The in-database rate limit on a browser call (take_web_rate, 0042/0087: per signed-in person, per window). The RPCs are reachable
-- through PostgREST by any editor without the Command Center, so the route's own limit (P5) is not enough. The bucket names are
-- `db.film.*`, never the route's, so the two limits do not count each other's calls.
create or replace function public.film_take_rate(p_bucket text, p_max integer) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.take_web_rate('db.film.' || p_bucket, p_max, 3600) then
    perform public.creative_refuse('rate_limited', format('at most %s film %s calls an hour; try again later', p_max, p_bucket), 'NS429');
  end if;
end
$$;

-- A JSON value that must be a uuid (or JSON null, answered as NULL).
create or replace function public.film_uuid(p_v jsonb, p_field text) returns uuid
  language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p_v is null or jsonb_typeof(p_v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_v) <> 'string'
     or (p_v #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    perform public.creative_refuse('invalid_params', format('%s must be an id', p_field));
  end if;
  return (p_v #>> '{}')::uuid;
end
$$;

-- A JSON value that must be text a person typed: cleaned (film_clean_text), then held to [p_min, p_max] characters.
create or replace function public.film_text(p_v jsonb, p_field text, p_min integer, p_max integer, p_multiline boolean)
  returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  t text;
begin
  if p_v is null or jsonb_typeof(p_v) <> 'string' then
    perform public.creative_refuse('invalid_params', format('%s must be text', p_field));
  end if;
  t := public.film_clean_text(p_v #>> '{}', p_multiline);
  if char_length(t) < p_min then
    perform public.creative_refuse('invalid_params', format('%s must not be empty', p_field));
  end if;
  if char_length(t) > p_max then
    perform public.creative_refuse('invalid_params', format('%s must be at most %s characters', p_field, p_max));
  end if;
  return t;
end
$$;

-- A live (not deleted) library file of this organization, of this kind.
create or replace function public.film_asset_live(p_org uuid, p_asset uuid, p_kind text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.media_assets a
                  where a.id = p_asset and a.org_id = p_org and a.kind = p_kind and a.deleted_at is null)
$$;

-- The same, as a refusal: another organization's file reads exactly like a missing one.
create or replace function public.film_check_asset(p_org uuid, p_v jsonb, p_kind text, p_field text) returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  a uuid := public.film_uuid(p_v, p_field);
begin
  if a is not null and not public.film_asset_live(p_org, a, p_kind) then
    perform public.creative_refuse('asset_not_usable', format('%s is not a %s in this library', p_field, p_kind));
  end if;
  return a;
end
$$;

-- A model a person just picked: never Seedance (BytePlus §4.2.3, see the header), and on sale on the web now for one of the
-- capabilities the role needs.
create or replace function public.film_check_model(p_model text, p_caps text[], p_field text) returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_model is null or p_model !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    perform public.creative_refuse('invalid_params', format('%s must be a model id', p_field));
  end if;
  -- Seedance by name, adapter or the vendor's own model id; not every ByteDance model (a Seedream key-frame model is not Seedance,
  -- and is held by its own terms gate through sellable_models below, with its own refusal).
  if p_model ilike '%seedance%'
     or exists (select 1 from public.model_registry m
                 where m.id = p_model
                   and (m.adapter ilike 'video.seedance%' or coalesce(m.spec ->> 'vendor_model', '') ilike '%seedance%')) then
    perform public.creative_refuse('model_not_offered',
      format('%s: Seedance models are not offered in Film Studio (the vendor''s terms forbid it)', p_field));
  end if;
  if not exists (select 1 from unnest(p_caps) c, lateral public.sellable_models(c, 'web') s where s.id = p_model) then
    perform public.creative_refuse('model_not_available', format('%s: %s is not on sale for this', p_field, p_model));
  end if;
end
$$;

-- The settings of a patch applied to a film row, each one checked. p_keys is what this caller may set. A model is checked only when
-- it changes (see the header); everything else is checked every time it is given.
create or replace function public.film_apply_settings(p_film public.films, p_patch jsonb, p_keys text[])
  returns public.films
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f   public.films := p_film;
  kv  record;
  v   jsonb;
  k   text;
  m   text;
  lim jsonb := public.film_limits();
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform public.creative_refuse('invalid_params', 'the settings must be an object');
  end if;
  for kv in select key, value from jsonb_each(p_patch) loop
    v := kv.value;
    if not kv.key = any (p_keys) then
      perform public.creative_refuse('invalid_params', format('unknown field %s', kv.key));
    end if;
    case kv.key
      when 'title' then
        f.title := public.film_text(v, 'title', 1, (lim ->> 'max_title_chars')::integer, false);
      when 'source_text' then
        f.source_text := public.film_text(v, 'source_text', 1,
          case when f.source_kind = 'topic' then (lim ->> 'max_topic_chars')::integer else (lim ->> 'max_script_chars')::integer end,
          true);
      when 'channel_id' then
        if jsonb_typeof(v) = 'null' then
          f.channel_id := null;
        elsif jsonb_typeof(v) <> 'string' or public.channel_org(v #>> '{}') is distinct from f.org_id then
          -- Another organization's channel and a channel that does not exist answer the same.
          perform public.creative_refuse('invalid_params', 'channel_id is not a channel of this organization');
        else
          f.channel_id := v #>> '{}';
        end if;
      when 'language' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('en', 'ru', 'uz') then
          perform public.creative_refuse('invalid_params', 'language must be en, ru or uz');
        end if;
        f.language := v #>> '{}';
      when 'aspect' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('16:9', '9:16', '1:1') then
          perform public.creative_refuse('invalid_params', 'aspect must be 16:9, 9:16 or 1:1');
        end if;
        f.aspect := v #>> '{}';
      when 'target_seconds' then
        if not public.creative_json_int(v, (lim ->> 'target_seconds_min')::numeric, (lim ->> 'target_seconds_max')::numeric) then
          perform public.creative_refuse('invalid_params',
            format('target_seconds must be a whole number from %s to %s', lim ->> 'target_seconds_min', lim ->> 'target_seconds_max'));
        end if;
        f.target_seconds := (v #>> '{}')::numeric::integer;
      when 'resolution' then
        if jsonb_typeof(v) = 'null' then
          f.resolution := null;
        elsif jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('480p', '720p', '768p', '1080p', '2k', '4k') then
          perform public.creative_refuse('invalid_params', 'resolution must be one of 480p, 720p, 768p, 1080p, 2k, 4k');
        else
          f.resolution := v #>> '{}';
        end if;
      when 'style_kit_id' then
        f.style_kit_id := public.film_uuid(v, 'style_kit_id');
        if f.style_kit_id is not null
           and not exists (select 1 from public.style_kits s where s.id = f.style_kit_id and s.org_id = f.org_id) then
          perform public.creative_refuse('invalid_params', 'style_kit_id is not a style kit of this organization');
        end if;
      when 'keyframe_model', 'clip_model' then
        if jsonb_typeof(v) = 'null' then
          m := null;
        elsif jsonb_typeof(v) <> 'string' then
          perform public.creative_refuse('invalid_params', format('%s must be a model id', kv.key));
        else
          m := v #>> '{}';
          if m is distinct from (case when kv.key = 'keyframe_model' then p_film.keyframe_model else p_film.clip_model end) then
            perform public.film_check_model(m, case when kv.key = 'keyframe_model' then array['t2i', 'edit'] else array['i2v'] end,
                                             kv.key);
          end if;
        end if;
        if kv.key = 'keyframe_model' then f.keyframe_model := m; else f.clip_model := m; end if;
      when 'voice' then
        if jsonb_typeof(v) = 'null' then
          f.voice := null;
        else
          if jsonb_typeof(v) <> 'object' then
            perform public.creative_refuse('invalid_params', 'voice must be an object');
          end if;
          for k in select jsonb_object_keys(v) loop
            if k not in ('source', 'model', 'voice_id') then
              perform public.creative_refuse('invalid_params', format('voice: unknown field %s', k));
            end if;
          end loop;
          if (v ->> 'source') is distinct from 'creative_tts' and (v ->> 'source') is distinct from 'channel' then
            perform public.creative_refuse('invalid_params', 'voice.source must be creative_tts or channel');
          end if;
          if v ->> 'source' = 'channel' then
            -- The channel's own configured voice: nothing else to name (the run checks it with verify_voice, rule 4).
            if v ? 'model' or v ? 'voice_id' then
              perform public.creative_refuse('invalid_params', 'voice: a channel voice takes no model or voice_id');
            end if;
          else
            if jsonb_typeof(v -> 'voice_id') is distinct from 'string' or (v ->> 'voice_id') !~ '^[A-Za-z0-9_-]{1,64}$' then
              perform public.creative_refuse('invalid_params', 'voice.voice_id must be a voice id from the list');
            end if;
            if jsonb_typeof(v -> 'model') is distinct from 'string' then
              perform public.creative_refuse('invalid_params', 'voice.model must be a model id');
            end if;
            if (v ->> 'model') is distinct from (p_film.voice ->> 'model') then
              perform public.film_check_model(v ->> 'model', array['tts'], 'voice.model');
            end if;
          end if;
          f.voice := v;
        end if;
      when 'music_asset_id' then
        f.music_asset_id := public.film_check_asset(f.org_id, v, 'audio', 'music_asset_id');
      when 'music_gain_db', 'duck_db' then
        if jsonb_typeof(v) = 'null' then
          m := null;
        elsif jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric not between -40 and 0
              or (v #>> '{}')::numeric <> round((v #>> '{}')::numeric, 1) then
          perform public.creative_refuse('invalid_params', format('%s must be a number from -40 to 0, in steps of 0.1', kv.key));
        else
          m := v #>> '{}';
        end if;
        if kv.key = 'music_gain_db' then f.music_gain_db := m::numeric; else f.duck_db := m::numeric; end if;
      when 'captions_mode' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('sidecar', 'burn', 'both', 'none') then
          perform public.creative_refuse('invalid_params', 'captions_mode must be sidecar, burn, both or none');
        end if;
        f.captions_mode := v #>> '{}';
      when 'transition_default' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('cut', 'dip_to_black', 'crossfade') then
          perform public.creative_refuse('invalid_params', 'transition_default must be cut, dip_to_black or crossfade');
        end if;
        f.transition_default := v #>> '{}';
    end case;
  end loop;
  if f.voice ->> 'source' = 'channel' and f.channel_id is null then
    perform public.creative_refuse('invalid_params', 'voice: a channel voice needs the film to have a channel');
  end if;
  return f;
end
$$;

-- Replace one reference list (the film's when p_scene is NULL, else that scene's) with p_refs, in order.
create or replace function public.film_save_refs(p_film public.films, p_scene uuid, p_refs jsonb, p_max integer, p_field text)
  returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r     record;
  k     text;
  kind_ text;
  ch    uuid;
  a     uuid;
  seen  text[] := '{}';
  label text;
begin
  if p_refs is null or jsonb_typeof(p_refs) <> 'array' then
    perform public.creative_refuse('invalid_params', format('%s must be a list', p_field));
  end if;
  if jsonb_array_length(p_refs) > p_max then
    perform public.creative_refuse('limit_reached', format('%s: at most %s references', p_field, p_max));
  end if;
  delete from public.film_refs where film_id = p_film.id and scene_id is not distinct from p_scene;
  for r in select v, ord from jsonb_array_elements(p_refs) with ordinality as t(v, ord) loop
    label := format('%s %s', p_field, r.ord);
    if jsonb_typeof(r.v) <> 'object' then
      perform public.creative_refuse('invalid_params', format('%s must be an object', label));
    end if;
    for k in select jsonb_object_keys(r.v) loop
      if k not in ('kind', 'character_id', 'asset_id') then
        perform public.creative_refuse('invalid_params', format('%s: unknown field %s', label, k));
      end if;
    end loop;
    kind_ := r.v ->> 'kind';
    if jsonb_typeof(r.v -> 'kind') is distinct from 'string' or kind_ not in ('character', 'style', 'location') then
      perform public.creative_refuse('invalid_params', format('%s: kind must be character, style or location', label));
    end if;
    ch := public.film_uuid(r.v -> 'character_id', label || ' character_id');
    a := public.film_check_asset(p_film.org_id, r.v -> 'asset_id', 'image', label || ' asset_id');
    if (ch is null) = (a is null) then
      perform public.creative_refuse('invalid_params', format('%s: give exactly one of character_id and asset_id', label));
    end if;
    if ch is not null then
      if kind_ <> 'character' then
        perform public.creative_refuse('invalid_params', format('%s: a character is of kind character', label));
      end if;
      if not exists (select 1 from public.characters c where c.id = ch and c.org_id = p_film.org_id) then
        perform public.creative_refuse('invalid_params', format('%s: character_id is not a character of this organization', label));
      end if;
    end if;
    if coalesce(ch, a)::text = any (seen) then
      perform public.creative_refuse('invalid_params', format('%s: the same reference is given twice', label));
    end if;
    seen := seen || coalesce(ch, a)::text;
    insert into public.film_refs (film_id, org_id, scene_id, kind, character_id, asset_id, position)
    values (p_film.id, p_film.org_id, p_scene, kind_, ch, a, r.ord - 1);
  end loop;
  return jsonb_array_length(p_refs);
end
$$;

-- Replace the storyboard with p_scenes (the whole ordered list; see the header). Returns the number of scenes.
create or replace function public.film_save_scenes(p_film public.films, p_scenes jsonb) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim    jsonb := public.film_limits();
  r      record;
  k      text;
  ids    uuid[] := '{}';
  sid    uuid;
  sc     public.film_scenes;
  old    public.film_scenes;
  label  text;
  x      jsonb;
  m      text;
  ck     text;
  is_new boolean;
begin
  if p_scenes is null or jsonb_typeof(p_scenes) <> 'array' then
    perform public.creative_refuse('invalid_params', 'scenes must be a list');
  end if;
  if jsonb_array_length(p_scenes) > (lim ->> 'max_scenes')::integer then
    perform public.creative_refuse('limit_reached', format('a film has at most %s scenes', lim ->> 'max_scenes'));
  end if;

  -- Which existing scenes the list keeps: each named once, each this film's.
  for r in select v, ord from jsonb_array_elements(p_scenes) with ordinality as t(v, ord) loop
    label := format('scene %s', r.ord);
    if jsonb_typeof(r.v) <> 'object' then
      perform public.creative_refuse('invalid_params', format('%s must be an object', label));
    end if;
    for k in select jsonb_object_keys(r.v) loop
      if k not in ('id', 'title', 'narration', 'visual_prompt', 'negative_prompt', 'planned_seconds', 'shot_count',
                   'first_frame', 'first_frame_asset_id', 'last_frame', 'last_frame_asset_id', 'keyframe_model', 'clip_model',
                   'clip_params', 'transition_in', 'refs') then
        perform public.creative_refuse('invalid_params', format('%s: unknown field %s', label, k));
      end if;
    end loop;
    if r.v ? 'id' then
      sid := public.film_uuid(r.v -> 'id', label || ' id');
      if sid is null or not exists (select 1 from public.film_scenes s where s.id = sid and s.film_id = p_film.id) then
        perform public.creative_refuse('invalid_params', format('%s: id is not a scene of this film', label));
      end if;
      if sid = any (ids) then
        perform public.creative_refuse('invalid_params', format('%s: the same scene is listed twice', label));
      end if;
      ids := ids || sid;
    end if;
  end loop;

  -- The scenes left out are deleted (their own references with them), unless something was already made for them.
  if exists (select 1 from public.film_takes t
              where t.film_id = p_film.id and t.scene_id is not null and not (t.scene_id = any (ids))) then
    perform public.creative_refuse('scene_has_takes', 'a scene that has takes cannot be deleted', 'NS409');
  end if;
  delete from public.film_scenes where film_id = p_film.id and not (id = any (ids));

  set constraints public.film_scenes_position_key deferred;
  for r in select v, ord from jsonb_array_elements(p_scenes) with ordinality as t(v, ord) loop
    label := format('scene %s', r.ord);
    is_new := not (r.v ? 'id');
    if is_new then
      old := null;
      sc := null;
      sc.id := gen_random_uuid();
      sc.title := ''; sc.narration := ''; sc.visual_prompt := ''; sc.negative_prompt := '';
      sc.shot_count := 1; sc.first_frame := 'keyframe'; sc.last_frame := 'none';
      sc.clip_params := '{}'::jsonb; sc.status := 'draft';
      if not (r.v ? 'planned_seconds') then
        perform public.creative_refuse('invalid_params', format('%s: planned_seconds is required', label));
      end if;
    else
      select * into old from public.film_scenes where id = (r.v ->> 'id')::uuid;
      sc := old;
    end if;
    sc.position := r.ord - 1;

    if r.v ? 'title' then
      sc.title := public.film_text(r.v -> 'title', label || ' title', 0, (lim ->> 'max_title_chars')::integer, false);
    end if;
    if r.v ? 'narration' then
      sc.narration := public.film_text(r.v -> 'narration', label || ' narration', 0, (lim ->> 'max_narration_chars')::integer, true);
    end if;
    if r.v ? 'visual_prompt' then
      sc.visual_prompt := public.film_text(r.v -> 'visual_prompt', label || ' visual_prompt', 0,
                                           (lim ->> 'max_prompt_chars')::integer, true);
    end if;
    if r.v ? 'negative_prompt' then
      sc.negative_prompt := public.film_text(r.v -> 'negative_prompt', label || ' negative_prompt', 0,
                                             (lim ->> 'max_negative_chars')::integer, true);
    end if;
    if r.v ? 'planned_seconds' then
      if not public.creative_json_int(r.v -> 'planned_seconds', (lim ->> 'scene_seconds_min')::numeric,
                                      (lim ->> 'scene_seconds_max')::numeric) then
        perform public.creative_refuse('invalid_params', format('%s: planned_seconds must be a whole number from %s to %s',
                                                                label, lim ->> 'scene_seconds_min', lim ->> 'scene_seconds_max'));
      end if;
      sc.planned_seconds := (r.v ->> 'planned_seconds')::numeric::integer;
    end if;
    if r.v ? 'shot_count' then
      if not public.creative_json_int(r.v -> 'shot_count', 1, (lim ->> 'max_shots')::numeric) then
        perform public.creative_refuse('invalid_params', format('%s: shot_count must be 1 to %s', label, lim ->> 'max_shots'));
      end if;
      sc.shot_count := (r.v ->> 'shot_count')::numeric::smallint;
    end if;
    if r.v ? 'first_frame' then
      if jsonb_typeof(r.v -> 'first_frame') is distinct from 'string'
         or (r.v ->> 'first_frame') not in ('keyframe', 'asset', 'previous') then
        perform public.creative_refuse('invalid_params', format('%s: first_frame must be keyframe, asset or previous', label));
      end if;
      sc.first_frame := r.v ->> 'first_frame';
    end if;
    if r.v ? 'first_frame_asset_id' then
      sc.first_frame_asset_id := public.film_check_asset(p_film.org_id, r.v -> 'first_frame_asset_id', 'image',
                                                          label || ' first_frame_asset_id');
    end if;
    if r.v ? 'last_frame' then
      if jsonb_typeof(r.v -> 'last_frame') is distinct from 'string'
         or (r.v ->> 'last_frame') not in ('none', 'asset', 'next_keyframe') then
        perform public.creative_refuse('invalid_params', format('%s: last_frame must be none, asset or next_keyframe', label));
      end if;
      sc.last_frame := r.v ->> 'last_frame';
    end if;
    if r.v ? 'last_frame_asset_id' then
      sc.last_frame_asset_id := public.film_check_asset(p_film.org_id, r.v -> 'last_frame_asset_id', 'image',
                                                         label || ' last_frame_asset_id');
    end if;
    -- A picture is kept only while its mode uses it, so switching a scene back to `keyframe` or `none` needs no second field.
    if sc.first_frame <> 'asset' then sc.first_frame_asset_id := null; end if;
    if sc.last_frame <> 'asset' then sc.last_frame_asset_id := null; end if;
    if sc.position = 0 and sc.first_frame = 'previous' then
      perform public.creative_refuse('invalid_params', format('%s: the first scene has no previous scene to continue from', label));
    end if;
    if sc.first_frame = 'asset' and sc.first_frame_asset_id is null then
      perform public.creative_refuse('invalid_params', format('%s: first_frame asset needs first_frame_asset_id', label));
    end if;
    if sc.last_frame = 'asset' and sc.last_frame_asset_id is null then
      perform public.creative_refuse('invalid_params', format('%s: last_frame asset needs last_frame_asset_id', label));
    end if;

    foreach ck in array array['keyframe_model', 'clip_model'] loop
      if r.v ? ck then
        x := r.v -> ck;
        if jsonb_typeof(x) = 'null' then
          m := null;
        elsif jsonb_typeof(x) <> 'string' then
          perform public.creative_refuse('invalid_params', format('%s: %s must be a model id', label, ck));
        else
          m := x #>> '{}';
          if m is distinct from (case when ck = 'keyframe_model' then old.keyframe_model else old.clip_model end) then
            perform public.film_check_model(m, case when ck = 'keyframe_model' then array['t2i', 'edit'] else array['i2v'] end,
                                             format('%s %s', label, ck));
          end if;
        end if;
        if ck = 'keyframe_model' then sc.keyframe_model := m; else sc.clip_model := m; end if;
      end if;
    end loop;

    if r.v ? 'clip_params' then
      x := r.v -> 'clip_params';
      if jsonb_typeof(x) <> 'object' then
        perform public.creative_refuse('invalid_params', format('%s: clip_params must be an object', label));
      end if;
      for k in select jsonb_object_keys(x) loop
        -- Our narration is the soundtrack, so a clip's own audio is a choice a person makes, never a default.
        if k = 'audio' then
          if jsonb_typeof(x -> 'audio') <> 'boolean' then
            perform public.creative_refuse('invalid_params', format('%s: clip_params.audio must be true or false', label));
          end if;
        elsif k = 'resolution' then
          if jsonb_typeof(x -> 'resolution') <> 'string'
             or (x ->> 'resolution') not in ('480p', '720p', '768p', '1080p', '2k', '4k') then
            perform public.creative_refuse('invalid_params', format('%s: clip_params.resolution is not one of the resolutions', label));
          end if;
        else
          perform public.creative_refuse('invalid_params', format('%s: clip_params: unknown field %s', label, k));
        end if;
      end loop;
      sc.clip_params := x;
    end if;
    if r.v ? 'transition_in' then
      x := r.v -> 'transition_in';
      if jsonb_typeof(x) = 'null' then
        sc.transition_in := null;
      elsif jsonb_typeof(x) <> 'string' or (x #>> '{}') not in ('cut', 'dip_to_black', 'crossfade') then
        perform public.creative_refuse('invalid_params', format('%s: transition_in must be cut, dip_to_black or crossfade', label));
      else
        sc.transition_in := x #>> '{}';
      end if;
    end if;

    if is_new then
      insert into public.film_scenes (id, film_id, org_id, position, title, narration, visual_prompt, negative_prompt,
                                      planned_seconds, shot_count, first_frame, first_frame_asset_id, last_frame,
                                      last_frame_asset_id, keyframe_model, clip_model, clip_params, transition_in, status)
      values (sc.id, p_film.id, p_film.org_id, sc.position, sc.title, sc.narration, sc.visual_prompt, sc.negative_prompt,
              sc.planned_seconds, sc.shot_count, sc.first_frame, sc.first_frame_asset_id, sc.last_frame,
              sc.last_frame_asset_id, sc.keyframe_model, sc.clip_model, sc.clip_params, sc.transition_in, sc.status);
    else
      update public.film_scenes
         set position = sc.position, title = sc.title, narration = sc.narration, visual_prompt = sc.visual_prompt,
             negative_prompt = sc.negative_prompt, planned_seconds = sc.planned_seconds, shot_count = sc.shot_count,
             first_frame = sc.first_frame, first_frame_asset_id = sc.first_frame_asset_id, last_frame = sc.last_frame,
             last_frame_asset_id = sc.last_frame_asset_id, keyframe_model = sc.keyframe_model, clip_model = sc.clip_model,
             clip_params = sc.clip_params, transition_in = sc.transition_in, updated_at = now()
       where id = sc.id;
    end if;
    if r.v ? 'refs' then
      perform public.film_save_refs(p_film, sc.id, r.v -> 'refs', (lim ->> 'max_scene_refs')::integer, label || ' ref');
    end if;
  end loop;
  set constraints public.film_scenes_position_key immediate;
  return jsonb_array_length(p_scenes);
end
$$;

-- What must hold across scenes once a save is written; checked on the rows themselves, so it cannot disagree with them.
create or replace function public.film_check_storyboard(p_film public.films) returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  lim   jsonb := public.film_limits();
  total integer;
  bad   integer;
begin
  select coalesce(sum(planned_seconds), 0) into total from public.film_scenes where film_id = p_film.id;
  if total > (lim ->> 'max_film_seconds')::integer then
    perform public.creative_refuse('limit_reached',
      format('the scenes add up to %s s; a film is at most %s s', total, lim ->> 'max_film_seconds'));
  end if;
  -- Ending on the next scene's key frame needs a next scene, and one that has a key frame (not one that continues from this one).
  select s.position + 1 into bad
    from public.film_scenes s
    left join public.film_scenes n on n.film_id = s.film_id and n.position = s.position + 1
   where s.film_id = p_film.id and s.last_frame = 'next_keyframe' and (n.id is null or n.first_frame = 'previous')
   order by s.position limit 1;
  if bad is not null then
    perform public.creative_refuse('invalid_params',
      format('scene %s: last_frame next_keyframe needs a next scene with a key frame of its own', bad));
  end if;
end
$$;

-- One reference or take as the app shows it: named columns only, so a column a later migration adds (money, a provider's task id)
-- reaches a viewer only when that migration lists it here.
create or replace function public.film_ref_json(r public.film_refs) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', r.id, 'scene_id', r.scene_id, 'kind', r.kind, 'character_id', r.character_id, 'asset_id', r.asset_id,
    'position', r.position,
    'missing', case when r.character_id is not null
                    then not exists (select 1 from public.characters c where c.id = r.character_id and c.org_id = r.org_id)
                    else not public.film_asset_live(r.org_id, r.asset_id, 'image') end)
$$;

create or replace function public.film_take_json(t public.film_takes) returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', t.id, 'scene_id', t.scene_id, 'version', t.version, 'shot_index', t.shot_index, 'kind', t.kind,
    'parent_take_id', t.parent_take_id, 'attempt', t.attempt, 'status', t.status, 'model', t.model,
    'prompt_final', t.prompt_final, 'params', t.params, 'duration_s', t.duration_s,
    'first_frame_asset_id', t.first_frame_asset_id, 'last_frame_asset_id', t.last_frame_asset_id,
    'reference_asset_ids', to_jsonb(t.reference_asset_ids), 'reshoot', t.reshoot, 'creative_job_id', t.creative_job_id,
    'result_asset_id', t.result_asset_id, 'result_last_frame_asset_id', t.result_last_frame_asset_id,
    'error_code', t.error_code, 'error', t.error,
    'created_at', t.created_at, 'updated_at', t.updated_at, 'finished_at', t.finished_at)
$$;

-- The film as the app shows it, named columns only (never the request hash, nor anything a later migration adds until it is listed
-- here). Unknowns stay unknown: a reference, frame, style kit or music file that no longer exists is flagged `missing`, a scene never
-- shot has current_version null, and no take is invented. The newest 50 events, with the total, so a long history says it is cut.
create or replace function public.film_read(p_film uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'film', jsonb_build_object(
      'id', f.id, 'org_id', f.org_id, 'channel_id', f.channel_id, 'title', f.title, 'source_kind', f.source_kind,
      'source_text', f.source_text, 'language', f.language, 'aspect', f.aspect, 'target_seconds', f.target_seconds,
      'resolution', f.resolution, 'style_kit_id', f.style_kit_id, 'keyframe_model', f.keyframe_model,
      'clip_model', f.clip_model, 'voice', f.voice, 'music_asset_id', f.music_asset_id, 'music_gain_db', f.music_gain_db,
      'duck_db', f.duck_db, 'captions_mode', f.captions_mode, 'transition_default', f.transition_default,
      'status', f.status, 'pause_reason', f.pause_reason, 'pause_detail', f.pause_detail, 'version', f.version,
      'idempotency_key', f.idempotency_key, 'created_by', f.created_by, 'created_at', f.created_at,
      'updated_at', f.updated_at, 'archived_at', f.archived_at),
    'editable', public.film_is_editable(f.status),
    'style_kit_missing', f.style_kit_id is not null
                         and not exists (select 1 from public.style_kits k where k.id = f.style_kit_id and k.org_id = f.org_id),
    'music_missing', f.music_asset_id is not null and not public.film_asset_live(f.org_id, f.music_asset_id, 'audio'),
    'totals', jsonb_build_object(
      'scenes', (select count(*) from public.film_scenes s where s.film_id = f.id),
      'planned_seconds', (select coalesce(sum(s.planned_seconds), 0) from public.film_scenes s where s.film_id = f.id)),
    'refs', coalesce((select jsonb_agg(public.film_ref_json(r) order by r.position)
                        from public.film_refs r where r.film_id = f.id and r.scene_id is null), '[]'::jsonb),
    'scenes', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', s.id, 'position', s.position, 'title', s.title, 'narration', s.narration,
                          'visual_prompt', s.visual_prompt, 'negative_prompt', s.negative_prompt,
                          'planned_seconds', s.planned_seconds, 'shot_count', s.shot_count,
                          'first_frame', s.first_frame, 'first_frame_asset_id', s.first_frame_asset_id,
                          'last_frame', s.last_frame, 'last_frame_asset_id', s.last_frame_asset_id,
                          'keyframe_model', s.keyframe_model, 'clip_model', s.clip_model, 'clip_params', s.clip_params,
                          'transition_in', s.transition_in, 'current_version', s.current_version, 'status', s.status,
                          'created_at', s.created_at, 'updated_at', s.updated_at,
                          'first_frame_missing', s.first_frame_asset_id is not null
                                                 and not public.film_asset_live(s.org_id, s.first_frame_asset_id, 'image'),
                          'last_frame_missing', s.last_frame_asset_id is not null
                                                and not public.film_asset_live(s.org_id, s.last_frame_asset_id, 'image'),
                          'refs', coalesce((select jsonb_agg(public.film_ref_json(r) order by r.position)
                                              from public.film_refs r where r.film_id = f.id and r.scene_id = s.id), '[]'::jsonb),
                          'takes', coalesce((select jsonb_agg(public.film_take_json(t) order by t.version, t.shot_index, t.attempt)
                                               from public.film_takes t where t.film_id = f.id and t.scene_id = s.id), '[]'::jsonb))
                          order by s.position)
                          from public.film_scenes s where s.film_id = f.id), '[]'::jsonb),
    'takes', coalesce((select jsonb_agg(public.film_take_json(t) order by t.kind, t.version, t.attempt)
                         from public.film_takes t where t.film_id = f.id and t.scene_id is null), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', e.id, 'event', e.event, 'scene_id', e.scene_id, 'actor', e.actor, 'actor_role', e.actor_role,
                          'detail', e.detail, 'created_at', e.created_at) order by e.id desc)
                          from (select * from public.film_events e where e.film_id = f.id order by e.id desc limit 50) e),
                       '[]'::jsonb),
    'events_total', (select count(*) from public.film_events e where e.film_id = f.id),
    'events_truncated', (select count(*) > 50 from public.film_events e where e.film_id = f.id),
    'limits', public.film_limits())
  from public.films f where f.id = p_film
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The browser's calls (signed-in members, through the Command Center)
-- ───────────────────────────────────────────────────────────────────────────

-- Read one film. Another organization's film reads exactly like a missing one.
create or replace function public.film_json(p_film uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  org uuid;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select f.org_id into org from public.films f where f.id = p_film;
  if org is null or not public.is_org_member(org, 'viewer') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return public.film_read(p_film);
end
$$;

-- A new draft: what it is from, and its settings (title, language and target_seconds are required). Nothing is planned, priced or
-- held: the film waits as a draft. The idempotency key is the caller's replay token (see the header).
create or replace function public.create_film_draft(
  p_org uuid,
  p_channel text,
  p_source_kind text,
  p_source_text text,
  p_settings jsonb,
  p_idempotency_key text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid  uuid := auth.uid();
  lim  jsonb := public.film_limits();
  st   jsonb := coalesce(p_settings, '{}'::jsonb);
  hash text;
  f    public.films;
  old  public.films;
begin
  if uid is null or p_org is null or not public.is_org_member(p_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$' then
    perform public.creative_refuse('invalid_idempotency_key', 'the idempotency key must be 8 to 128 letters, digits or _.:-');
  end if;
  if jsonb_typeof(st) <> 'object' or octet_length(st::text) > 65536 then
    perform public.creative_refuse('invalid_params', 'the settings must be an object');
  end if;
  if p_source_kind is null or p_source_kind not in ('topic', 'script') then
    perform public.creative_refuse('invalid_params', 'source_kind must be topic or script');
  end if;
  hash := md5(jsonb_build_object('org', p_org, 'channel', p_channel, 'kind', p_source_kind, 'text', p_source_text,
                                 'settings', st)::text);

  -- One writer per organization at a time: the replay lookup and the draft count below cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('films:' || p_org::text, 0));
  select * into old from public.films where org_id = p_org and idempotency_key = p_idempotency_key;
  if found then
    if old.request_hash <> hash then
      perform public.creative_refuse('idempotency_conflict', 'this idempotency key was used for a different film', 'NS409');
    end if;
    return public.film_read(old.id);
  end if;
  if (select count(*) from public.films where org_id = p_org and public.film_is_editable(status))
     >= (lim ->> 'max_open_drafts')::integer then
    perform public.creative_refuse('limit_reached',
      format('an organization keeps at most %s open drafts; archive one first', lim ->> 'max_open_drafts'));
  end if;
  -- Archived films count too: archiving frees an open-draft place, never storage, so create, save, archive in a loop cannot grow
  -- the database without bound (docs/FILM_STUDIO.md, "Storage and erasure").
  if (select count(*) from public.films where org_id = p_org) >= (lim ->> 'max_films_total')::integer then
    perform public.creative_refuse('limit_reached',
      format('an organization keeps at most %s films, archived ones included; ask the operator to erase old ones',
             lim ->> 'max_films_total'));
  end if;
  perform public.film_take_rate('create', (lim ->> 'creates_per_hour')::integer);

  -- The two the caller passes as arguments are not also settings: one source for each.
  if st ? 'source_text' or st ? 'channel_id' then
    perform public.creative_refuse('invalid_params', 'source_text and channel_id are arguments, not settings');
  end if;
  f.id := gen_random_uuid();
  f.org_id := p_org;
  f.source_kind := p_source_kind;
  f.aspect := '16:9';
  f.captions_mode := 'sidecar';
  f.transition_default := 'cut';
  f.status := 'draft';
  f.version := 1;
  f.idempotency_key := p_idempotency_key;
  f.request_hash := hash;
  f.created_by := uid;
  f.created_at := now();
  f.updated_at := now();
  f := public.film_apply_settings(f,
         st || jsonb_build_object('source_text', coalesce(to_jsonb(p_source_text), 'null'::jsonb),
                                  'channel_id', coalesce(to_jsonb(p_channel), 'null'::jsonb)),
         array['title', 'language', 'aspect', 'target_seconds', 'resolution', 'style_kit_id', 'keyframe_model', 'clip_model',
               'voice', 'music_asset_id', 'music_gain_db', 'duck_db', 'captions_mode', 'transition_default',
               'source_text', 'channel_id']);
  if f.title is null or f.language is null or f.target_seconds is null then
    perform public.creative_refuse('invalid_params', 'title, language and target_seconds are required');
  end if;

  -- Named columns, not (f.*): a column a later migration adds with a default must get that default, not this record's NULL.
  insert into public.films (id, org_id, channel_id, title, source_kind, source_text, language, aspect, target_seconds, resolution,
                            style_kit_id, keyframe_model, clip_model, voice, music_asset_id, music_gain_db, duck_db, captions_mode,
                            transition_default, status, version, idempotency_key, request_hash, created_by, created_at, updated_at)
  values (f.id, f.org_id, f.channel_id, f.title, f.source_kind, f.source_text, f.language, f.aspect, f.target_seconds, f.resolution,
          f.style_kit_id, f.keyframe_model, f.clip_model, f.voice, f.music_asset_id, f.music_gain_db, f.duck_db, f.captions_mode,
          f.transition_default, f.status, f.version, f.idempotency_key, f.request_hash, f.created_by, f.created_at, f.updated_at);
  perform public.film_log(f.id, f.org_id, null, 'created',
                          jsonb_build_object('source_kind', f.source_kind, 'channel_id', f.channel_id));
  return public.film_read(f.id);
end
$$;

-- Edit a draft: settings, the storyboard (scenes) and the film-wide references, at the version the caller read.
create or replace function public.save_film(p_film uuid, p_version integer, p_patch jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim     jsonb := public.film_limits();
  org     uuid;
  f       public.films;
  n       public.films;
  touched text[];
  scenes  integer;
  refs    integer;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Authorised before any lock: a stranger cannot make a member's save wait on a row lock it should never have taken.
  select x.org_id into org from public.films x where x.id = p_film;
  if org is null or not public.is_org_member(org, 'viewer') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Locked: two saves of the same version make one edit and one film_changed. NO KEY UPDATE, not UPDATE: the key never changes,
  -- and a child row being written (a take, an event) holds KEY SHARE on the film, which UPDATE would wait for.
  select * into f from public.films where id = p_film for no key update;
  if not public.film_is_editable(f.status) then
    perform public.creative_refuse('film_not_editable', format('a %s film cannot be edited', f.status), 'NS409');
  end if;
  if p_version is distinct from f.version then
    perform public.creative_refuse('film_changed', format('the film is at version %s', f.version), 'NS409');
  end if;
  if (select count(*) from public.film_events e where e.film_id = f.id) >= (lim ->> 'max_events_per_film')::integer then
    perform public.creative_refuse('limit_reached',
      format('this film has reached %s recorded changes; ask the operator to erase old films or start a new one',
             lim ->> 'max_events_per_film'));
  end if;
  perform public.film_take_rate('save', (lim ->> 'saves_per_hour')::integer);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform public.creative_refuse('invalid_params', 'the patch must be an object with at least one field');
  end if;
  if octet_length(p_patch::text) > (lim ->> 'max_patch_bytes')::integer then
    perform public.creative_refuse('limit_reached', 'the patch is too large');
  end if;
  select array_agg(k order by k) into touched from jsonb_object_keys(p_patch) k;

  n := public.film_apply_settings(f, p_patch - 'scenes' - 'refs',
         array['title', 'source_text', 'channel_id', 'language', 'aspect', 'target_seconds', 'resolution', 'style_kit_id',
               'keyframe_model', 'clip_model', 'voice', 'music_asset_id', 'music_gain_db', 'duck_db', 'captions_mode',
               'transition_default']);
  update public.films
     set title = n.title, source_text = n.source_text, channel_id = n.channel_id, language = n.language, aspect = n.aspect,
         target_seconds = n.target_seconds, resolution = n.resolution, style_kit_id = n.style_kit_id,
         keyframe_model = n.keyframe_model, clip_model = n.clip_model, voice = n.voice, music_asset_id = n.music_asset_id,
         music_gain_db = n.music_gain_db, duck_db = n.duck_db, captions_mode = n.captions_mode,
         transition_default = n.transition_default, version = version + 1, updated_at = now()
   where id = f.id
  returning * into n;
  if p_patch ? 'refs' then
    refs := public.film_save_refs(n, null, p_patch -> 'refs', (lim ->> 'max_film_refs')::integer, 'ref');
  end if;
  if p_patch ? 'scenes' then
    scenes := public.film_save_scenes(n, p_patch -> 'scenes');
  end if;
  perform public.film_check_storyboard(n);

  perform public.film_log(f.id, f.org_id, null, 'saved',
                          jsonb_strip_nulls(jsonb_build_object('from_version', f.version, 'to_version', n.version,
                                                               'fields', to_jsonb(touched), 'scenes', scenes, 'refs', refs)));
  return public.film_read(f.id);
end
$$;

-- Put a draft away: it keeps its storyboard and history, stops counting toward the open-draft limit, and can no longer be edited.
-- Archiving an archived film again changes nothing and writes nothing.
create or replace function public.archive_film(p_film uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim jsonb := public.film_limits();
  org uuid;
  f   public.films;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.org_id into org from public.films x where x.id = p_film;
  if org is null or not public.is_org_member(org, 'viewer') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into f from public.films where id = p_film for no key update;
  if f.status = 'archived' then
    return public.film_read(f.id);
  end if;
  if not public.film_is_editable(f.status) then
    perform public.creative_refuse('film_not_editable', format('a %s film cannot be archived', f.status), 'NS409');
  end if;
  perform public.film_take_rate('archive', (lim ->> 'archives_per_hour')::integer);
  update public.films
     set status = 'archived', archived_at = now(), version = version + 1, updated_at = now()
   where id = f.id;
  perform public.film_log(f.id, f.org_id, null, 'archived', jsonb_build_object('from_status', f.status));
  return public.film_read(f.id);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.films enable row level security;
alter table public.film_scenes enable row level security;
alter table public.film_refs enable row level security;
alter table public.film_takes enable row level security;
alter table public.film_events enable row level security;

-- Rows change only through the functions above: no direct write for anyone, the service key included.
revoke all on public.films, public.film_scenes, public.film_refs, public.film_takes, public.film_events
  from public, anon, authenticated, service_role;
-- The trusted backend reads whole rows; a signed-in member reads the columns named here and nothing else, so a column a later
-- migration adds (money, a provider's task id) is invisible to a browser until that migration grants it on purpose
-- (tests/security/test_sec_films_core.py pins the lists). Never the request hash.
grant select on public.films, public.film_scenes, public.film_refs, public.film_takes, public.film_events to service_role;
grant select (id, org_id, channel_id, title, source_kind, source_text, language, aspect, target_seconds, resolution, style_kit_id,
              keyframe_model, clip_model, voice, music_asset_id, music_gain_db, duck_db, captions_mode, transition_default, status,
              pause_reason, pause_detail, version, idempotency_key, created_by, created_at, updated_at, archived_at)
  on public.films to authenticated;
grant select (id, film_id, org_id, position, title, narration, visual_prompt, negative_prompt, planned_seconds, shot_count,
              first_frame, first_frame_asset_id, last_frame, last_frame_asset_id, keyframe_model, clip_model, clip_params,
              transition_in, current_version, status, created_at, updated_at)
  on public.film_scenes to authenticated;
grant select (id, film_id, org_id, scene_id, kind, character_id, asset_id, position, created_at)
  on public.film_refs to authenticated;
grant select (id, film_id, org_id, scene_id, version, shot_index, kind, parent_take_id, attempt, status, model, prompt_final, params,
              duration_s, first_frame_asset_id, last_frame_asset_id, reference_asset_ids, reshoot, creative_job_id, result_asset_id,
              result_last_frame_asset_id, error_code, error, created_at, updated_at, finished_at)
  on public.film_takes to authenticated;
grant select (id, film_id, org_id, scene_id, actor, actor_role, event, detail, created_at)
  on public.film_events to authenticated;
-- The identity behind film_events.id: nobody but its owner draws from it (no API role could insert anyway).
revoke all on sequence public.film_events_id_seq from public, anon, authenticated, service_role;

drop policy if exists films_select on public.films;
create policy films_select on public.films
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists film_scenes_select on public.film_scenes;
create policy film_scenes_select on public.film_scenes
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists film_refs_select on public.film_refs;
create policy film_refs_select on public.film_refs
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists film_takes_select on public.film_takes;
create policy film_takes_select on public.film_takes
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists film_events_select on public.film_events;
create policy film_events_select on public.film_events
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

revoke all on function public.film_clean_text(text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.film_text_ok(text, integer, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function public.film_limits() from public, anon, authenticated, service_role;
revoke all on function public.film_is_editable(text) from public, anon, authenticated, service_role;
revoke all on function public.film_events_append_only() from public, anon, authenticated, service_role;
revoke all on function public.film_log(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.film_uuid(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.film_text(jsonb, text, integer, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function public.film_asset_live(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.film_check_asset(uuid, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.film_check_model(text, text[], text) from public, anon, authenticated, service_role;
revoke all on function public.film_take_rate(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.film_ref_json(public.film_refs) from public, anon, authenticated, service_role;
revoke all on function public.film_take_json(public.film_takes) from public, anon, authenticated, service_role;
revoke all on function public.film_apply_settings(public.films, jsonb, text[]) from public, anon, authenticated, service_role;
revoke all on function public.film_save_refs(public.films, uuid, jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.film_save_scenes(public.films, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.film_check_storyboard(public.films) from public, anon, authenticated, service_role;
revoke all on function public.film_read(uuid) from public, anon, authenticated, service_role;

revoke all on function public.film_json(uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_film_draft(uuid, text, text, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.save_film(uuid, integer, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.archive_film(uuid) from public, anon, authenticated, service_role;
grant execute on function public.film_json(uuid) to authenticated;
grant execute on function public.create_film_draft(uuid, text, text, text, jsonb, text) to authenticated;
grant execute on function public.save_film(uuid, integer, jsonb) to authenticated;
grant execute on function public.archive_film(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   to_regclass('public.films') is not null and to_regclass('public.film_scenes') is not null
--     and to_regclass('public.film_refs') is not null and to_regclass('public.film_takes') is not null
--     and to_regclass('public.film_events') is not null                                              as tables_exist,
--   (select bool_and(c.relrowsecurity) from pg_class c
--     where c.oid in ('public.films'::regclass, 'public.film_scenes'::regclass, 'public.film_refs'::regclass,
--                     'public.film_takes'::regclass, 'public.film_events'::regclass))                as rls_on,
--   not exists (select 1 from unnest(array['public.films', 'public.film_scenes', 'public.film_refs', 'public.film_takes',
--                                          'public.film_events']) t,
--                             unnest(array['anon', 'authenticated', 'service_role']) r,
--                             unnest(array['insert', 'update', 'delete', 'truncate']) p
--                where has_table_privilege(r, t, p))                                                as no_direct_writes,
--   has_function_privilege('authenticated', 'public.save_film(uuid, integer, jsonb)', 'execute')
--     and has_function_privilege('authenticated', 'public.create_film_draft(uuid, text, text, text, jsonb, text)', 'execute')
--     and has_function_privilege('authenticated', 'public.film_json(uuid)', 'execute')
--     and not has_function_privilege('anon', 'public.save_film(uuid, integer, jsonb)', 'execute')
--     and not has_function_privilege('authenticated', 'public.film_read(uuid)', 'execute')
--     and not has_function_privilege('service_role', 'public.create_film_draft(uuid, text, text, text, jsonb, text)', 'execute') as grants_ok,
--   (select bool_and(p.proconfig @> array['search_path=public, pg_temp'])
--      from pg_proc p
--     where p.pronamespace = 'public'::regnamespace and p.proname like any (array['film%', '%_film', '%_film_%']))  as search_path_pinned,
--   exists (select 1 from pg_trigger where tgrelid = 'public.film_events'::regclass and tgname = 'film_events_append_only') as append_only,
--   not has_column_privilege('authenticated', 'public.films', 'request_hash', 'select')
--     and not has_table_privilege('authenticated', 'public.films', 'select')                         as members_read_named_columns,
--   not has_sequence_privilege('authenticated', 'public.film_events_id_seq', 'usage')
--     and not has_sequence_privilege('anon', 'public.film_events_id_seq', 'usage')                   as sequence_closed;
