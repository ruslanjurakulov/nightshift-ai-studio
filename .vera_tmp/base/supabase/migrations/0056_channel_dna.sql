-- 0056_channel_dna.sql — Channel DNA: one place for a channel's look and
-- voice, which every creation surface pre-fills from.
--
-- A channel's DNA is: its default style kit, its default characters, its
-- narrator voice, its script language, its default format (long / Shorts) and
-- aspect, and a short free-text tone line. Setting it spends nothing and starts
-- nothing; the Studio panel and the Run now form only start from it, and the
-- person can change anything per job.
--
-- WHERE EACH PART LIVES (existing columns reused; only what was missing added)
--   style kit       channels.default_style_kit_id        (0047, unchanged; its
--                                                         same-org guard already
--                                                         holds for every writer)
--   narrator voice  channels.agent_config.elevenlabs_voice_id (the pipeline's own key)
--   language        channels.agent_config.language       ('Uzbek' | 'Russian' |
--                                                         'English', as the
--                                                         pipeline reads it)
--   characters      channel_dna_characters               NEW: channel -> 0047
--                                                         character, ordered, at
--                                                         most 8
--   format          channels.dna_format                  NEW: 'long' | 'shorts' | null
--   aspect          channels.dna_aspect                  NEW: '16:9' | '9:16' | '1:1' | null
--   tone            channels.dna_tone                    NEW: one line, <= 200 characters
--
-- A CHARACTER IS ALWAYS THE CHANNEL'S OWN ORGANIZATION'S (enforced three times)
--   * set_channel_dna accepts only ids of characters of the channel's org; any
--     other id — another org's, a deleted one, a made-up one — is the same
--     refusal ('invalid_character'), so the answer says nothing about whether
--     someone else's character exists. The style kit the same way
--     ('invalid_style_kit').
--   * every channel_dna_characters row carries org_id, and a composite foreign
--     key (character_id, org_id) -> characters (id, org_id) pins the character
--     to that org (ON DELETE CASCADE: deleting a character leaves no dangling id);
--   * a BEFORE trigger refuses a row whose org_id is not the channel's org — for
--     every writer, the service role and the owner included.
--   A channel moved to another organization (0018) drops its old org's
--   characters, as 0047 drops its old org's kit, rather than being blocked.
--
-- WHO MAY DO WHAT (authenticated = a signed-in browser via the anon key)
--   set_channel_dna(channel, ...)    authenticated; writes only for an editor of
--                                    the channel's organization — the same rule
--                                    as channels' own update policy (0018). A
--                                    channel the caller cannot see reads as not
--                                    found; one they can see but not edit is
--                                    forbidden.
--   channels.dna_*                   also writable through channels' existing
--                                    update policy (editor), held by the check
--                                    constraints below
--   channel_dna_characters           select: members of the org (viewer), like
--                                    channels · nothing else — written only by
--                                    set_channel_dna
--   service_role                     select on channel_dna_characters (the
--                                    pipeline reads a channel's DNA)
--   anon gets nothing.
--
-- set_channel_dna REPLACES the DNA in one transaction:
--   p_style_kit_id   null clears the default kit
--   p_character_ids  null or {} clears; at most 8, distinct
--   p_voice_id       null leaves the narrator voice as it is (a channel's
--                    voice is never cleared from here: a run with no voice
--                    would fall back to one nobody picked); else 20 letters
--                    and digits
--   p_language       null leaves the language as it is; else 'uz' | 'ru' | 'en'
--   p_format         null clears; 'long' | 'shorts'
--   p_aspect         null clears; '16:9' | '9:16' | '1:1'
--   p_tone           null or blank clears; control characters removed, trimmed,
--                    <= 200 characters
-- Only the two agent_config keys named above are touched; every other key of
-- agent_config (publish settings, auto publish, the gate, ...) is left exactly
-- as it is — merged in the database, never rewritten from a browser's copy.
-- Returns the stored DNA as jsonb.
--
-- ERRORS (SQLSTATE; the message is the machine code the app maps,
-- command-center/lib/channel-dna.ts mapDnaError):
--   42501 forbidden (not signed in / not an editor of the channel's org)
--   P0002 not_found (no such channel, or not one the caller can see)
--   NS400 invalid_style_kit | invalid_character | too_many_characters |
--         duplicate_character | invalid_voice | invalid_language |
--         invalid_format | invalid_aspect | invalid_tone
--
-- REQUIRES 0018 (organizations) and 0047 (style kits, characters). Additive
-- and idempotent: guarded columns and constraints, a guarded table,
-- drop-then-create policies and triggers, create-or-replace functions.
-- Nothing existing is dropped or changed.

do $$
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0056 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regclass('public.characters') is null
     or to_regprocedure('public.style_clean_text(text, boolean)') is null then
    raise exception '0056 needs style kits and characters: apply 0047_style_kits_characters.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. channels: format, aspect, tone
-- ───────────────────────────────────────────────────────────────────────────

alter table public.channels add column if not exists dna_format text;
alter table public.channels add column if not exists dna_aspect text;
alter table public.channels add column if not exists dna_tone text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'channels_dna_format_check') then
    alter table public.channels
      add constraint channels_dna_format_check check (dna_format is null or dna_format in ('long', 'shorts'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'channels_dna_aspect_check') then
    alter table public.channels
      add constraint channels_dna_aspect_check check (dna_aspect is null or dna_aspect in ('16:9', '9:16', '1:1'));
  end if;
  -- One line a person typed: no control characters, so it can never smuggle a
  -- second instruction into the script prompt on its own line.
  if not exists (select 1 from pg_constraint where conname = 'channels_dna_tone_check') then
    alter table public.channels
      add constraint channels_dna_tone_check
      check (dna_tone is null or (char_length(dna_tone) between 1 and 200 and dna_tone !~ '[[:cntrl:]]'));
  end if;
end $$;

comment on column public.channels.dna_format is
  'Channel DNA (migration 0056): the format new work starts in, long or shorts, or null. Pre-fills only.';
comment on column public.channels.dna_aspect is
  'Channel DNA (migration 0056): the aspect new pictures and clips start in, or null (then the format decides). Pre-fills only.';
comment on column public.channels.dna_tone is
  'Channel DNA (migration 0056): one line on how the channel sounds; the pipeline adds it to the script prompt.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. channel_dna_characters
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.channel_dna_characters (
  channel_id   text not null references public.channels (channel_id) on update cascade on delete cascade,
  org_id       uuid not null,
  character_id uuid not null,
  -- 0..7 and unique per channel: no channel can ever hold more than 8.
  position     smallint not null check (position between 0 and 7),
  created_at   timestamptz not null default now(),
  primary key (channel_id, character_id),
  constraint channel_dna_characters_position_key unique (channel_id, position),
  constraint channel_dna_characters_character_fkey foreign key (character_id, org_id)
    references public.characters (id, org_id) on delete cascade
);

create index if not exists channel_dna_characters_org_idx on public.channel_dna_characters (org_id);
create index if not exists channel_dna_characters_character_idx on public.channel_dna_characters (character_id);

comment on table public.channel_dna_characters is
  'Channel DNA (migration 0056): a channel''s default characters, in order (at most 8). Same organization as the channel (trigger) and as the character (composite foreign key). Written only by set_channel_dna().';

-- The row's org is the channel's org. Security definer so the check sees the
-- channel whatever the writer may read.
create or replace function public.channel_dna_character_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.channels c
                  where c.channel_id = new.channel_id and c.org_id = new.org_id) then
    raise exception 'invalid_character'
      using errcode = 'NS400',
            detail = 'a channel''s character must belong to the channel''s organization';
  end if;
  return new;
end
$$;

drop trigger if exists channel_dna_characters_guard on public.channel_dna_characters;
create trigger channel_dna_characters_guard
  before insert or update on public.channel_dna_characters
  for each row execute function public.channel_dna_character_guard();

-- A channel that moves to another organization leaves its old org's
-- characters behind (the old org's kit is cleared the same way, 0047).
create or replace function public.channels_dna_org_moved() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.org_id is distinct from old.org_id then
    delete from public.channel_dna_characters
     where channel_id = new.channel_id and org_id is distinct from new.org_id;
  end if;
  return null;
end
$$;

drop trigger if exists channels_dna_org_moved on public.channels;
create trigger channels_dna_org_moved
  after update of org_id on public.channels
  for each row execute function public.channels_dna_org_moved();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. set_channel_dna
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.set_channel_dna(
  p_channel_id    text,
  p_style_kit_id  uuid,
  p_character_ids uuid[],
  p_voice_id      text,
  p_language      text,
  p_format        text,
  p_aspect        text,
  p_tone          text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ch     public.channels;
  ids    uuid[] := coalesce(p_character_ids, '{}'::uuid[]);
  n      integer := coalesce(cardinality(p_character_ids), 0);
  tone_  text := nullif(public.style_clean_text(p_tone, false), '');
  lang_  text;
  patch  jsonb := '{}'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into ch from public.channels where channel_id = p_channel_id;
  -- A channel the caller cannot see reads as missing, never as "forbidden".
  if not found or not public.is_org_member(ch.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- The channels update policy's rule (0018): an editor of the channel's org.
  if not public.is_org_member(ch.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Locked only once the caller is known to be allowed: a stranger's call
  -- must not be able to hold someone else's channel row.
  select * into ch from public.channels where channel_id = p_channel_id for update;
  if not found or not public.is_org_member(ch.org_id, 'editor') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if p_style_kit_id is not null and not exists (
    select 1 from public.style_kits k where k.id = p_style_kit_id and k.org_id = ch.org_id
  ) then
    raise exception 'invalid_style_kit'
      using errcode = 'NS400', detail = 'the style kit must be one of the channel''s organization''s';
  end if;

  if n > 8 then
    raise exception 'too_many_characters' using errcode = 'NS400', detail = format('max=8 count=%s', n);
  end if;
  if array_position(ids, null) is not null then
    raise exception 'invalid_character' using errcode = 'NS400';
  end if;
  if (select count(distinct x) from unnest(ids) x) <> n then
    raise exception 'duplicate_character' using errcode = 'NS400';
  end if;
  if (select count(*) from public.characters c where c.id = any (ids) and c.org_id = ch.org_id) <> n then
    raise exception 'invalid_character'
      using errcode = 'NS400', detail = 'every character must be one of the channel''s organization''s';
  end if;

  if p_voice_id is not null then
    if p_voice_id !~ '^[A-Za-z0-9]{20}$' then
      raise exception 'invalid_voice' using errcode = 'NS400', detail = 'pattern=^[A-Za-z0-9]{20}$';
    end if;
    patch := patch || jsonb_build_object('elevenlabs_voice_id', p_voice_id);
  end if;
  if p_language is not null then
    lang_ := case p_language when 'uz' then 'Uzbek' when 'ru' then 'Russian' when 'en' then 'English' end;
    if lang_ is null then
      raise exception 'invalid_language' using errcode = 'NS400', detail = 'one of uz, ru, en';
    end if;
    patch := patch || jsonb_build_object('language', lang_);
  end if;
  if p_format is not null and p_format not in ('long', 'shorts') then
    raise exception 'invalid_format' using errcode = 'NS400';
  end if;
  if p_aspect is not null and p_aspect not in ('16:9', '9:16', '1:1') then
    raise exception 'invalid_aspect' using errcode = 'NS400';
  end if;
  if tone_ is not null and char_length(tone_) > 200 then
    raise exception 'invalid_tone' using errcode = 'NS400', detail = 'max=200';
  end if;

  update public.channels
     set default_style_kit_id = p_style_kit_id,
         dna_format = p_format,
         dna_aspect = p_aspect,
         dna_tone = tone_,
         -- Merged here, under the row lock: a browser's stale copy of the blob
         -- can never undo another setting (auto publish, the gate) on the way.
         agent_config = coalesce(agent_config, '{}'::jsonb) || patch,
         updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where channel_id = ch.channel_id;

  delete from public.channel_dna_characters where channel_id = ch.channel_id;
  insert into public.channel_dna_characters (channel_id, org_id, character_id, position)
  select ch.channel_id, ch.org_id, u.c, (u.o - 1)::smallint
    from unnest(ids) with ordinality as u(c, o);

  return jsonb_build_object(
    'channel_id', ch.channel_id,
    'style_kit_id', p_style_kit_id,
    'character_ids', to_jsonb(ids),
    'voice_id', coalesce(p_voice_id, ch.agent_config ->> 'elevenlabs_voice_id'),
    'language', coalesce(lang_, ch.agent_config ->> 'language'),
    'format', p_format,
    'aspect', p_aspect,
    'tone', tone_);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.channel_dna_characters enable row level security;

revoke all on public.channel_dna_characters from public, anon, authenticated, service_role;
grant select on public.channel_dna_characters to authenticated;
grant select on public.channel_dna_characters to service_role;

-- Whoever may see the channel sees its characters: channels_auth_read's rule.
drop policy if exists channel_dna_characters_select on public.channel_dna_characters;
create policy channel_dna_characters_select on public.channel_dna_characters
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

revoke all on function public.channel_dna_character_guard() from public, anon, authenticated, service_role;
revoke all on function public.channels_dna_org_moved() from public, anon, authenticated, service_role;
revoke all on function public.set_channel_dna(text, uuid, uuid[], text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_channel_dna(text, uuid, uuid[], text, text, text, text, text) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select relrowsecurity from pg_class where oid = 'public.channel_dna_characters'::regclass) as rls_on,
--   not has_table_privilege('authenticated', 'public.channel_dna_characters', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.channel_dna_characters', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.channel_dna_characters', 'DELETE')
--     and not has_table_privilege('anon', 'public.channel_dna_characters', 'SELECT') as browser_scoped,
--   has_function_privilege('authenticated', 'public.set_channel_dna(text,uuid,uuid[],text,text,text,text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.set_channel_dna(text,uuid,uuid[],text,text,text,text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.channel_dna_character_guard()', 'EXECUTE')
--     as functions_scoped,
--   (select prosecdef and proconfig::text like '%search_path%' from pg_proc
--     where oid = 'public.set_channel_dna(text,uuid,uuid[],text,text,text,text,text)'::regprocedure) as definer_pinned,
--   (select count(*) from information_schema.columns
--     where table_schema = 'public' and table_name = 'channels'
--       and column_name in ('dna_format', 'dna_aspect', 'dna_tone')) = 3 as channel_columns;
