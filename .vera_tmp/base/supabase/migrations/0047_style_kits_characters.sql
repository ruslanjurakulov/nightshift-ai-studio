-- 0047_style_kits_characters.sql — style kits ("Uslub to'plami") and
-- characters ("Qahramon"): reusable looks and recurring subjects, built from
-- an organization's own media library (docs/research/competitors.md §2/§5:
-- moodboards and consistent characters, done our way).
--
-- WHAT IT ADDS
--   style_kits               a named look: 3–12 reference images from the
--                            org's library plus a short text description the
--                            person writes (an LLM-written one is a later PR;
--                            nothing here calls a model or spends a credit).
--   characters               a recurring character or product, addressable in
--                            a prompt as @name (^[a-z0-9_]{2,32}$, unique per
--                            organization), with 1–8 reference images and a
--                            description.
--   style_kit_references     kit -> media_assets, ordered (position 0..11)
--   character_references     character -> media_assets, ordered (position 0..7)
--   channels.default_style_kit_id
--                            optional: the kit a channel looks like by
--                            default. ON DELETE SET NULL — deleting a kit
--                            leaves the channel with no default, never a
--                            dangling id.
--   save_style_kit(org, kit, name, description, asset_ids)
--   save_character(org, character, name, kind, description, asset_ids)
--                            create (kit/character null) or replace one, with
--                            its references, in ONE transaction.
--
-- A REFERENCE IS ALWAYS THE SAME ORGANIZATION'S (enforced three times)
--   * save_* accept only ids of LIVE IMAGE assets of the kit's own org; any
--     other id — another org's, a deleted one, a video, a made-up one — is the
--     same refusal ('invalid_reference'), so the answer says nothing about
--     whether someone else's asset exists.
--   * every reference row carries org_id, and a composite foreign key
--     (kit_id, org_id) -> style_kits (id, org_id) pins it to its owner's org;
--   * a BEFORE trigger on the reference tables refuses an asset whose org is
--     not the row's org — for every writer, the service role and the owner
--     included, not just the functions above.
--   A channel's default kit is checked the same way (channels_style_kit_guard):
--   the kit must belong to the channel's organization.
--
-- LIMITS (the database's, not the form's)
--   kit: name 1–60 characters, description <= 2000, 3–12 references,
--        50 kits per organization
--   character: name ^[a-z0-9_]{2,32}$, description <= 2000, 1–8 references,
--        100 characters per organization
--   The upper reference bound is structural (position is 0..11 / 0..7 and
--   unique per owner); the lower one is a deferred constraint trigger checked
--   at commit, after a save has replaced the whole set.
--
-- WHO MAY DO WHAT (authenticated = a signed-in browser via the anon key)
--   style_kits, characters         select: members of the org (viewer) ·
--                                  delete: editors of the org (a self-serve
--                                  customer owns their org) · insert/update:
--                                  nobody directly — save_* only
--   style_kit_references,
--   character_references           select: members of the org · nothing else
--   save_style_kit, save_character authenticated; each checks editor
--                                  membership itself. Another org's kit or
--                                  character reads as not found.
--   channels.default_style_kit_id  written through channels' existing update
--                                  policy (editor), plus the same-org guard
--   service_role                   select only (generation reads it later)
--   anon gets nothing.
--
-- ERRORS (SQLSTATE; the message is the machine code the app maps,
-- lib/style-kits.ts mapStyleError):
--   42501 forbidden (not signed in / not an editor of the org)
--   P0002 not_found (kit / character / a channel's kit not in this org)
--   NS400 invalid_name | invalid_description | invalid_kind |
--         too_few_references | too_many_references | duplicate_reference |
--         invalid_reference
--   NS409 name_taken (a character's @name is already used in this org)
--   NS429 limit_reached (the org has the maximum number of kits/characters)
--
-- NOT WIRED INTO GENERATION YET: nothing reads these tables during a run.
-- command-center/lib/server/style-kits.ts loadStyleContext(orgId) is the
-- typed read a later generation PR will use.
--
-- REQUIRES 0018 (organizations) and 0038 (media_assets). Additive and
-- idempotent: guarded creates, a guarded column and constraint on channels,
-- drop-then-create policies and triggers, create-or-replace functions.
-- Nothing existing is dropped or changed.

do $$
begin
  if to_regprocedure('public.accessible_org_ids(text)') is null
     or to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0047 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regclass('public.media_assets') is null then
    raise exception '0047 needs the media library: apply 0038_media_assets.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.style_kits (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60 and name !~ '[[:cntrl:]]'),
  description text not null default '' check (char_length(description) <= 2000),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- The target of the references' composite foreign key: a reference row can
  -- only name a kit of the org it says it belongs to.
  constraint style_kits_id_org_key unique (id, org_id)
);

create index if not exists style_kits_org_idx on public.style_kits (org_id, created_at desc);

comment on table public.style_kits is
  'Style kits (migration 0047): 3-12 reference images from the org''s library plus a text description. Written only by save_style_kit(); members read, editors delete.';

create table if not exists public.characters (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  -- The @name: what a prompt will address it by.
  name        text not null check (name ~ '^[a-z0-9_]{2,32}$'),
  kind        text not null default 'character' check (kind in ('character', 'product')),
  description text not null default '' check (char_length(description) <= 2000),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint characters_org_name_key unique (org_id, name),
  constraint characters_id_org_key unique (id, org_id)
);

create index if not exists characters_org_idx on public.characters (org_id, created_at desc);

comment on table public.characters is
  'Recurring characters / products (migration 0047), addressable as @name (unique per org), with 1-8 reference images. Written only by save_character(); members read, editors delete.';

create table if not exists public.style_kit_references (
  kit_id     uuid not null,
  org_id     uuid not null,
  asset_id   uuid not null references public.media_assets (id) on delete cascade,
  -- 0..11 and unique per kit: no kit can ever hold more than 12.
  position   smallint not null check (position between 0 and 11),
  created_at timestamptz not null default now(),
  primary key (kit_id, asset_id),
  constraint style_kit_references_position_key unique (kit_id, position),
  constraint style_kit_references_kit_fkey foreign key (kit_id, org_id)
    references public.style_kits (id, org_id) on delete cascade
);

create index if not exists style_kit_references_org_idx on public.style_kit_references (org_id);
create index if not exists style_kit_references_asset_idx on public.style_kit_references (asset_id);

comment on table public.style_kit_references is
  'A style kit''s reference images (migration 0047), in order. Same organization as the kit (composite foreign key) and as the asset (trigger).';

create table if not exists public.character_references (
  character_id uuid not null,
  org_id       uuid not null,
  asset_id     uuid not null references public.media_assets (id) on delete cascade,
  position     smallint not null check (position between 0 and 7),
  created_at   timestamptz not null default now(),
  primary key (character_id, asset_id),
  constraint character_references_position_key unique (character_id, position),
  constraint character_references_character_fkey foreign key (character_id, org_id)
    references public.characters (id, org_id) on delete cascade
);

create index if not exists character_references_org_idx on public.character_references (org_id);
create index if not exists character_references_asset_idx on public.character_references (asset_id);

comment on table public.character_references is
  'A character''s reference images (migration 0047), in order. Same organization as the character (composite foreign key) and as the asset (trigger).';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Guards that hold for every writer
-- ───────────────────────────────────────────────────────────────────────────

-- A reference names a live image of the row's own organization. Security
-- definer so the check sees the asset whatever the writer may read; the
-- refusal is the same for "another org's", "deleted", "not an image" and
-- "no such asset".
create or replace function public.style_reference_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from public.media_assets a
     where a.id = new.asset_id and a.org_id = new.org_id
       and a.kind = 'image' and a.deleted_at is null
  ) then
    raise exception 'invalid_reference'
      using errcode = 'NS400',
            detail = 'a reference must be a live image in the same organization''s library';
  end if;
  return new;
end
$$;

drop trigger if exists style_kit_references_guard on public.style_kit_references;
create trigger style_kit_references_guard
  before insert or update on public.style_kit_references
  for each row execute function public.style_reference_guard();

drop trigger if exists character_references_guard on public.character_references;
create trigger character_references_guard
  before insert or update on public.character_references
  for each row execute function public.style_reference_guard();

-- At commit, an owner that gained references holds at least its minimum (the
-- maximum is structural). Checked only when references are written: removing
-- an asset row (an org being deleted) must never be blocked by a kit.
create or replace function public.style_reference_count_check() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n  integer;
  lo integer;
begin
  if tg_table_name = 'style_kit_references' then
    if not exists (select 1 from public.style_kits where id = new.kit_id) then
      return null;
    end if;
    select count(*) into n from public.style_kit_references where kit_id = new.kit_id;
    lo := 3;
  else
    if not exists (select 1 from public.characters where id = new.character_id) then
      return null;
    end if;
    select count(*) into n from public.character_references where character_id = new.character_id;
    lo := 1;
  end if;
  if n < lo then
    raise exception 'too_few_references' using errcode = 'NS400', detail = format('min=%s count=%s', lo, n);
  end if;
  return null;
end
$$;

drop trigger if exists style_kit_references_count on public.style_kit_references;
create constraint trigger style_kit_references_count
  after insert on public.style_kit_references
  deferrable initially deferred
  for each row execute function public.style_reference_count_check();

drop trigger if exists character_references_count on public.character_references;
create constraint trigger character_references_count
  after insert on public.character_references
  deferrable initially deferred
  for each row execute function public.style_reference_count_check();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. channels.default_style_kit_id
-- ───────────────────────────────────────────────────────────────────────────

alter table public.channels add column if not exists default_style_kit_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'channels_default_style_kit_fkey') then
    alter table public.channels
      add constraint channels_default_style_kit_fkey foreign key (default_style_kit_id)
      references public.style_kits (id) on delete set null;
  end if;
end $$;

create index if not exists idx_channels_default_style_kit
  on public.channels (default_style_kit_id) where default_style_kit_id is not null;

comment on column public.channels.default_style_kit_id is
  'The style kit this channel looks like by default (migration 0047), or null. Must belong to the channel''s organization (channels_style_kit_guard).';

-- The kit must be the channel's organization's. A channel moved to another
-- organization (0018: admin in both) leaves its old org's kit behind rather
-- than being blocked by it; naming another org's kit is refused as "not
-- found", for every writer.
create or replace function public.channels_style_kit_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.default_style_kit_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.org_id is distinct from old.org_id
     and new.default_style_kit_id is not distinct from old.default_style_kit_id
     and not exists (select 1 from public.style_kits k
                      where k.id = new.default_style_kit_id and k.org_id = new.org_id) then
    new.default_style_kit_id := null;
    return new;
  end if;
  if not exists (select 1 from public.style_kits k
                  where k.id = new.default_style_kit_id and k.org_id = new.org_id) then
    raise exception 'not_found'
      using errcode = 'P0002', detail = 'a channel''s default style kit must belong to the channel''s organization';
  end if;
  return new;
end
$$;

drop trigger if exists channels_style_kit_guard on public.channels;
create trigger channels_style_kit_guard
  before insert or update of default_style_kit_id, org_id on public.channels
  for each row execute function public.channels_style_kit_guard();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- Text a person typed, made storable: control characters removed (a
-- description keeps its line breaks and tabs), \r\n folded to \n, trimmed.
create or replace function public.style_clean_text(p_text text, p_multiline boolean) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select btrim(case when p_multiline
                    then regexp_replace(replace(coalesce(p_text, ''), E'\r\n', E'\n'),
                                        E'[\\x01-\\x08\\x0b\\x0c\\x0d\\x0e-\\x1f\\x7f]', '', 'g')
                    else regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]', '', 'g') end)
$$;

-- The asset list a save was given, checked: count within [lo, hi], no nulls,
-- no duplicates, every id a live image of p_org. Raises the machine code.
create or replace function public.style_check_assets(p_org uuid, p_assets uuid[], p_lo integer, p_hi integer)
  returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  n integer := coalesce(cardinality(p_assets), 0);
begin
  if n < p_lo then
    raise exception 'too_few_references' using errcode = 'NS400', detail = format('min=%s count=%s', p_lo, n);
  end if;
  if n > p_hi then
    raise exception 'too_many_references' using errcode = 'NS400', detail = format('max=%s count=%s', p_hi, n);
  end if;
  if array_position(p_assets, null) is not null then
    raise exception 'invalid_reference' using errcode = 'NS400';
  end if;
  if (select count(distinct a) from unnest(p_assets) a) <> n then
    raise exception 'duplicate_reference' using errcode = 'NS400';
  end if;
  if (select count(*) from public.media_assets m
       where m.id = any (p_assets) and m.org_id = p_org
         and m.kind = 'image' and m.deleted_at is null) <> n then
    raise exception 'invalid_reference'
      using errcode = 'NS400',
            detail = 'every reference must be a live image in this organization''s library';
  end if;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. save_style_kit / save_character
-- ───────────────────────────────────────────────────────────────────────────

-- p_kit null: create a kit in p_org. p_kit set: replace that kit's name,
-- description and references (its org is the kit's own; p_org, if given,
-- must agree). Returns the kit id.
create or replace function public.save_style_kit(
  p_org uuid, p_kit uuid, p_name text, p_description text, p_assets uuid[]
) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k     public.style_kits;
  org_  uuid := p_org;
  name_ text := public.style_clean_text(p_name, false);
  desc_ text := public.style_clean_text(p_description, true);
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_kit is not null then
    select * into k from public.style_kits where id = p_kit for update;
    -- Another organization's kit reads as missing, never as "forbidden".
    if not found or not public.is_org_member(k.org_id) or (p_org is not null and p_org <> k.org_id) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    org_ := k.org_id;
  end if;
  if org_ is null or not public.is_org_member(org_, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if char_length(name_) not between 1 and 60 then
    raise exception 'invalid_name' using errcode = 'NS400', detail = 'max=60';
  end if;
  if char_length(desc_) > 2000 then
    raise exception 'invalid_description' using errcode = 'NS400', detail = 'max=2000';
  end if;
  perform public.style_check_assets(org_, p_assets, 3, 12);

  -- One writer per organization at a time: the per-org cap holds under
  -- parallel requests.
  perform pg_advisory_xact_lock(hashtextextended('style_kits:' || org_::text, 0));

  if p_kit is null then
    if (select count(*) from public.style_kits where org_id = org_) >= 50 then
      raise exception 'limit_reached' using errcode = 'NS429', detail = 'max=50';
    end if;
    insert into public.style_kits (org_id, name, description, created_by)
    values (org_, name_, desc_, auth.uid())
    returning * into k;
  else
    update public.style_kits set name = name_, description = desc_, updated_at = now()
     where id = k.id
    returning * into k;
    delete from public.style_kit_references where kit_id = k.id;
  end if;

  insert into public.style_kit_references (kit_id, org_id, asset_id, position)
  select k.id, org_, u.a, (u.o - 1)::smallint
    from unnest(p_assets) with ordinality as u(a, o);

  return k.id;
end
$$;

-- p_character null: create one in p_org; set: replace it. p_name is the @name
-- (a leading '@' and surrounding blanks are dropped, letters lower-cased).
create or replace function public.save_character(
  p_org uuid, p_character uuid, p_name text, p_kind text, p_description text, p_assets uuid[]
) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  c     public.characters;
  org_  uuid := p_org;
  name_ text := regexp_replace(lower(btrim(coalesce(p_name, ''))), '^@', '');
  kind_ text := coalesce(nullif(btrim(coalesce(p_kind, '')), ''), 'character');
  desc_ text := public.style_clean_text(p_description, true);
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_character is not null then
    select * into c from public.characters where id = p_character for update;
    if not found or not public.is_org_member(c.org_id) or (p_org is not null and p_org <> c.org_id) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    org_ := c.org_id;
  end if;
  if org_ is null or not public.is_org_member(org_, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if name_ !~ '^[a-z0-9_]{2,32}$' then
    raise exception 'invalid_name' using errcode = 'NS400', detail = 'pattern=^[a-z0-9_]{2,32}$';
  end if;
  if kind_ not in ('character', 'product') then
    raise exception 'invalid_kind' using errcode = 'NS400';
  end if;
  if char_length(desc_) > 2000 then
    raise exception 'invalid_description' using errcode = 'NS400', detail = 'max=2000';
  end if;
  perform public.style_check_assets(org_, p_assets, 1, 8);

  perform pg_advisory_xact_lock(hashtextextended('characters:' || org_::text, 0));

  if exists (select 1 from public.characters x
              where x.org_id = org_ and x.name = name_ and x.id is distinct from p_character) then
    raise exception 'name_taken' using errcode = 'NS409';
  end if;

  if p_character is null then
    if (select count(*) from public.characters where org_id = org_) >= 100 then
      raise exception 'limit_reached' using errcode = 'NS429', detail = 'max=100';
    end if;
    insert into public.characters (org_id, name, kind, description, created_by)
    values (org_, name_, kind_, desc_, auth.uid())
    returning * into c;
  else
    update public.characters set name = name_, kind = kind_, description = desc_, updated_at = now()
     where id = c.id
    returning * into c;
    delete from public.character_references where character_id = c.id;
  end if;

  insert into public.character_references (character_id, org_id, asset_id, position)
  select c.id, org_, u.a, (u.o - 1)::smallint
    from unnest(p_assets) with ordinality as u(a, o);

  return c.id;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.style_kits enable row level security;
alter table public.characters enable row level security;
alter table public.style_kit_references enable row level security;
alter table public.character_references enable row level security;

revoke all on public.style_kits from public, anon, authenticated, service_role;
revoke all on public.characters from public, anon, authenticated, service_role;
revoke all on public.style_kit_references from public, anon, authenticated, service_role;
revoke all on public.character_references from public, anon, authenticated, service_role;
grant select, delete on public.style_kits to authenticated;
grant select, delete on public.characters to authenticated;
grant select on public.style_kit_references to authenticated;
grant select on public.character_references to authenticated;
grant select on public.style_kits to service_role;
grant select on public.characters to service_role;
grant select on public.style_kit_references to service_role;
grant select on public.character_references to service_role;

drop policy if exists style_kits_select on public.style_kits;
create policy style_kits_select on public.style_kits
  for select to authenticated
  using (org_id in (select public.accessible_org_ids()));

drop policy if exists style_kits_delete on public.style_kits;
create policy style_kits_delete on public.style_kits
  for delete to authenticated
  using (org_id in (select public.accessible_org_ids('editor')));

drop policy if exists characters_select on public.characters;
create policy characters_select on public.characters
  for select to authenticated
  using (org_id in (select public.accessible_org_ids()));

drop policy if exists characters_delete on public.characters;
create policy characters_delete on public.characters
  for delete to authenticated
  using (org_id in (select public.accessible_org_ids('editor')));

drop policy if exists style_kit_references_select on public.style_kit_references;
create policy style_kit_references_select on public.style_kit_references
  for select to authenticated
  using (org_id in (select public.accessible_org_ids()));

drop policy if exists character_references_select on public.character_references;
create policy character_references_select on public.character_references
  for select to authenticated
  using (org_id in (select public.accessible_org_ids()));

revoke all on function public.style_reference_guard() from public, anon, authenticated, service_role;
revoke all on function public.style_reference_count_check() from public, anon, authenticated, service_role;
revoke all on function public.channels_style_kit_guard() from public, anon, authenticated, service_role;
revoke all on function public.style_clean_text(text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.style_check_assets(uuid, uuid[], integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.save_style_kit(uuid, uuid, text, text, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.save_character(uuid, uuid, text, text, text, uuid[]) from public, anon, authenticated, service_role;

grant execute on function public.save_style_kit(uuid, uuid, text, text, uuid[]) to authenticated;
grant execute on function public.save_character(uuid, uuid, text, text, text, uuid[]) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select bool_and(relrowsecurity) from pg_class
--     where oid in ('public.style_kits'::regclass, 'public.characters'::regclass,
--                   'public.style_kit_references'::regclass, 'public.character_references'::regclass)) as rls_on,
--   not has_table_privilege('authenticated', 'public.style_kits', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.style_kits', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.style_kit_references', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.character_references', 'DELETE')
--     and not has_table_privilege('anon', 'public.style_kits', 'SELECT')
--     and not has_table_privilege('anon', 'public.characters', 'SELECT') as browser_scoped,
--   has_function_privilege('authenticated', 'public.save_style_kit(uuid,uuid,text,text,uuid[])', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.save_style_kit(uuid,uuid,text,text,uuid[])', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.style_check_assets(uuid,uuid[],integer,integer)', 'EXECUTE')
--     as functions_scoped,
--   exists (select 1 from information_schema.columns
--            where table_schema = 'public' and table_name = 'channels'
--              and column_name = 'default_style_kit_id') as channel_column;
