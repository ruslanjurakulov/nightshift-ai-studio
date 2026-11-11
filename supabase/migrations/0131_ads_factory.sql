-- 0131_ads_factory.sql — Ads Factory, Phase 1: brand kits, brand products, ad campaigns and ad concepts (docs/ADS_FACTORY.md).
-- The database half of "write down a brand by hand, pick its products, plan a campaign, keep the concept drafts a person edits and approves".
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It ADDS seven tables, twelve internal functions and ten functions a
-- signed-in member may call. It replaces NOTHING that exists there, rewrites no existing row, adds no column to an existing table and touches no
-- existing function, policy or grant (the last block asserts the end state, and tests/test_ads_factory_migration.py pins that no other object is
-- named). Until the owner sets NIGHTSHIFT_ADS_FACTORY=on on the Command Center nothing in the APPLICATION calls any of it: the page and the
-- /api/ads/* routes answer 404 before they ask the database anything. The DATABASE is not dark: the ten member functions are granted to
-- `authenticated` from the moment this applies, so a signed-in member can call them directly through PostgREST (the public anon key and
-- their own session) while the page is off, within the caps below and only in an organization where they are an editor. Rows made that
-- way are real rows: the rollback then refuses unless told the rows may go (docs/ADS_FACTORY.md, "Known limits").
--
-- WHAT THIS DOES NOT DO. Nothing here fetches a web site (site_url is TEXT: a note a person typed, read by nothing), calls a model or any
-- provider, prices, holds, charges or refunds a credit, queues a job, publishes, or changes a video's privacy. There is no worker function and
-- no queue kind in this file. A concept is words in a table: "approved" means a person marked the words as final, and it starts nothing
-- (CLAUDE.md rule 3: a browser writes a row and stops). Generating pictures and video from an approved concept is Phase 3 and Phase 4, each with
-- its own migration, quote and hold.
--
-- NUMBER. 0131: the highest on main is 0129 (the multi-ratio export, #661, 0129_editor_export_frame, merged). 0130 is taken by the agent
-- workflow drafts (#652, renumbered from 0129 to 0130), an open pull request. This file depends on neither and they depend on nothing
-- here: it names no object any migration after 0107 creates and replaces no function, so it applies in any order relative to 0129 and 0130.
--
-- APPLY AS ONE TRANSACTION: the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1. `set local lock_timeout`
-- assumes it, and the last block of this file asserts the end state, so a half-applied file cannot be left behind.
--
-- WHAT IT ADDS
--   brand_kits            a brand, written by hand: name, the site address AS TEXT, a logo (a picture of the organization's own media library),
--                         up to 8 colours (#rrggbb), up to 4 font NAMES (no font file is stored or fetched), voice notes, and where the row came
--                         from (source: manual | scan; every row this file's functions write is `manual`, `scan` is for the Phase 2 worker).
--   brand_products        a product of a kit: title, description, the price AS TEXT (never a number, never used in arithmetic), source.
--   brand_product_images  product -> media_assets, ordered (position 0..3).
--   ad_campaigns          a campaign of a kit: name, objective, language, formats and art directions, each from a CLOSED list.
--   ad_campaign_products  campaign -> brand_products, ordered (position 0..19); the composite foreign keys make it impossible for a campaign to
--                         name a product of another kit or another organization.
--   ad_concepts           one concept draft: campaign, product, format, art direction, kind (image | video), headline, body, call to action,
--                         visual brief, storyboard beats (video only), status draft | approved | archived.
--   ads_factory_cap_settings   one row: the owner's caps (below).
--
-- WHO MAY DO WHAT. The same model as style kits (0047), the closest existing feature: an organization's reusable creative material built from its
-- own media library, where nothing is spent.
--   RLS: a member (viewer or above) of the organization reads its rows. NO API role (anon, authenticated, service_role) has INSERT, UPDATE,
--   DELETE, TRUNCATE, REFERENCES or TRIGGER on any of the seven tables. anon has nothing at all. service_role has SELECT on the six content
--   tables only (what a later worker needs to read a brief it was handed), and nothing on the settings.
--   Every write is a SECURITY DEFINER function with a pinned search_path (public, pg_temp), EXECUTE revoked from public, anon, authenticated and
--   service_role, then granted to `authenticated` alone; each checks sign-in, membership and the EDITOR role itself:
--     save_brand_kit, delete_brand_kit, save_brand_product, delete_brand_product, save_ad_campaign, delete_ad_campaign,
--     add_ad_concepts, update_ad_concept, set_ad_concept_status, delete_ad_concept
--   A missing id and another organization's id are the SAME answer (SQLSTATE P0002, message `not_found`): no oracle for another tenant's ids.
--   A picture is accepted only if it is a LIVE IMAGE of the kit's own organization; another organization's, a deleted one, a video and a made-up
--   id are the same refusal (`invalid_reference`), in the function AND in a trigger that holds for every writer.
--
-- THE CAPS (ads_factory_cap_settings; counted in the database from the rows, never from anything the client sends, under one advisory lock per
-- organization so two presses cannot both pass):
--     kits_per_org            brand kits one organization may hold                 default 5    (0..100)
--     products_per_kit        products one kit may hold                            default 20   (0..200)
--     campaigns_per_org       campaigns one organization may hold                  default 20   (0..1000)
--     concepts_per_campaign   concepts one campaign may hold, archived included    default 24   (0..200)
--   0 refuses every create of that kind (a pause that needs no deploy). A refusal is `limit_reached` (NS429) with `max=N` in its detail, and the
--   whole call rolls back. Changed in the SQL editor only, as the series plan caps of 0127 are: RLS on with NO policy, every privilege revoked
--   from every API role, the row cannot be deleted or emptied, and a change of a number leaves a security_events row (kind ads.factory.caps).
--   A missing row (only a superuser can remove it) reads as the defaults, never as "no cap". The seed is `on conflict do nothing`, so a replay
--   never undoes what the owner set. Change a number, e.g.:   update public.ads_factory_cap_settings set kits_per_org = 10;
--   Structural limits that are NOT settings: 4 pictures per product, 20 products per campaign, 12 concepts per add, 8 storyboard beats.
--
-- THE TEXT. Every text a person types is stored cleaned and length-capped, by the function AND by a check on the table: control characters and
-- every character nobody sees (the class the comment inbox removes, BR-L-120, with the Unicode tag block, every variation selector and the
-- Hangul and braille fillers; ads_clean_text lists it) are removed, the blank-looking spaces read as one space, a single-line field has its
-- line breaks read as one space, a multi-line field keeps its line breaks only, and a text of nothing but blanks is empty (refused where a
-- character is needed). Nothing here renders text as HTML and nothing here sends it to a model. site_url is refused unless it is https, a
-- lower-case DNS name with a letter top-level label (so no IP literal, no `localhost`), no user:password, no port and printable ASCII after
-- the host: a shape check on a note, not permission to fetch it and no defence against a name that resolves to a private address (Phase 2's
-- scanner must resolve the name and pin a public address at fetch time).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; run as the SQL editor on the live project). None of the names may exist yet (expected: no row):
--     select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace
--       and c.relname in ('brand_kits', 'brand_products', 'brand_product_images', 'ad_campaigns', 'ad_campaign_products', 'ad_concepts',
--                         'ads_factory_cap_settings');
--     select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace
--       and (p.proname like 'ads\_%' or p.proname like 'ad\_concepts\_%'
--            or p.proname in ('save_brand_kit', 'delete_brand_kit', 'save_brand_product', 'delete_brand_product', 'save_ad_campaign',
--                             'delete_ad_campaign', 'add_ad_concepts', 'update_ad_concept', 'set_ad_concept_status', 'delete_ad_concept'));
--   If a row comes back, STOP: something with one of these names was made by hand. The file refuses a function of one of its names that does
--   not hold this file's body (md5 of the body with every run of white space read as one space; the list is in the first DO block below and
--   again in the last one), and `create table if not exists` would silently keep a hand-made table, which the end state then refuses.
--   The prerequisites it reads (expected: one row, all true):
--     select to_regprocedure('public.is_org_member(uuid, text)') is not null, to_regprocedure('public.accessible_org_ids(text)') is not null,
--            to_regclass('public.media_assets') is not null, to_regprocedure('public.security_event_log(text, text, text, jsonb)') is not null;
--
-- Additive and idempotent: create table if not exists, drop constraint then add, create or replace, drop trigger / policy then create, revoke
-- then grant, seed `on conflict do nothing`. A second run changes nothing (the owner's numbers included). An applied migration is never edited.
-- Rollback: docs/sql/rollback_0131_ads_factory.sql (drops exactly what this file added; it DELETES every kit, product, campaign and concept).
-- REQUIRES 0018 (organizations, is_org_member, accessible_org_ids), 0038 (media_assets) and 0107 (security_event_log).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.organizations') is null
     or to_regprocedure('public.is_org_member(uuid, text)') is null
     or to_regprocedure('public.accessible_org_ids(text)') is null then
    raise exception '0131 needs 0018_organizations.sql (organizations, is_org_member, accessible_org_ids): apply it first';
  end if;
  if to_regclass('public.media_assets') is null then
    raise exception '0131 needs 0038_media_assets.sql (media_assets): apply it first';
  end if;
  if to_regprocedure('public.security_event_log(text, text, text, jsonb)') is null then
    raise exception '0131 needs 0107_owner_safety.sql (security_event_log): apply it first';
  end if;
end $$;

-- A function of one of this file's names that already exists must be this file's (a replay). Anything else was made by hand, and replacing it
-- would silently undo that. md5 of prosrc with every run of white space read as one space; tests/test_ads_factory_migration.py recomputes every
-- hash from this file.
do $$
declare
  r   record;
  got text;
begin
  for r in
    select * from (values
      ('public.ads_clean_text(text, boolean)', '53ecd0c6309be86c4e134da323146e61'),
      ('public.ads_text_ok(text, integer, integer, boolean)', '78ebe62fa220880ef2494563ab6cad99'),
      ('public.ads_text_list_ok(text[], integer, integer)', '3a5bd8e451a350dd799c9b49f6bb5061'),
      ('public.ads_palette_ok(text[])', '94dfa0449defc9f2907f6e7ba9a00243'),
      ('public.ads_closed_list_ok(text[], text[], integer, integer)', 'd932104160cc4768d10342395e74128d'),
      ('public.ads_site_url_ok(text)', '798012d1ead26b8383414e2720740fe9'),
      ('public.ads_storyboard_ok(jsonb)', 'b4576417d2448f8478888786eff3d912'),
      ('public.ads_check_images(uuid, uuid[], integer)', 'db5500a074148d993bd0a677720e7aae'),
      ('public.ads_asset_guard()', '3d8efe4d0763c2d88f35b54da1cfd025'),
      ('public.ad_concepts_guard()', '8f2f17776e0e93af231a1aec923ead88'),
      ('public.ads_factory_cap_settings_guard()', '51dafe4ec2c9f35974e9ff8289a6106b'),
      ('public.ads_factory_cap_settings_trail()', '986d228f1ab027e44e8a6837a1a49b3e'),
      ('public.save_brand_kit(uuid, uuid, text, text, uuid, text[], text[], text)', 'c6d162ea7c8abd3fa78243a1b3b6ae88'),
      ('public.delete_brand_kit(uuid)', '38a605d9ff0aa9a8d49526c5f0e32733'),
      ('public.save_brand_product(uuid, uuid, text, text, text, uuid[])', '16de653c6557c7be611d4a6be2eeabd6'),
      ('public.delete_brand_product(uuid)', '7f1f41e614b47c3762cc49a08867a39d'),
      ('public.save_ad_campaign(uuid, uuid, text, text, text, text[], text[], uuid[])', '05765d4994fc9a9a0bf0f090f7692b23'),
      ('public.delete_ad_campaign(uuid)', 'f40f5bd45d120c36e095a5a659cdd347'),
      ('public.add_ad_concepts(uuid, text, jsonb)', 'ef6ece5fadc12da31a3706be99095263'),
      ('public.update_ad_concept(uuid, text, text, text, text, jsonb)', '92f3faa8775c9cceb6d867d632567002'),
      ('public.set_ad_concept_status(uuid, text)', '0f4a08254f801319c12718f319dfa612'),
      ('public.delete_ad_concept(uuid)', '821913088f82cc84b7aba3398c5bf029')
    ) v(sig, want)
  loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = to_regprocedure(r.sig);
    if got is not null and got <> r.want then
      raise exception '0131 found a % that is not 0131''s body (md5 %): read the live body first', r.sig, got;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Text and list rules (internal: no API role may call them)
-- ───────────────────────────────────────────────────────────────────────────

-- Text a person typed, made storable. Removed: control characters and every character nobody sees, the class the comment inbox removes
-- (BR-L-120: modules/comment_replies.py, inbox_clean_text, tests/fixtures/inbox_cleaner_cases.txt) and the two emoji/text selectors U+FE0E and
-- U+FE0F as well: the C1 block, soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul fillers (U+115F, U+1160, U+3164, U+FFA0),
-- Khmer inherent vowels, Mongolian selectors and vowel separator, zero-width and direction marks, line/paragraph separators, embeddings and
-- overrides, word joiner, invisible operators and deprecated format controls (U+2060-206F), braille blank, every variation selector
-- (U+FE00-FE0F, and U+E0100-E01EF inside the tag block), BOM, interlinear annotation controls, the Egyptian, Bamum and musical format controls,
-- and the whole Unicode tag block U+E0000-E0FFF (text spelled in tag characters is invisible and is a hidden-instruction channel to a model:
-- visual_brief is what a later phase hands an image model). So a name cannot be made to read as another brand's, and nothing hides in a brief.
-- A single-line field reads a run of line breaks or tabs as one space; a multi-line field keeps its line breaks (\r\n and \r folded to \n) and
-- nothing else. The blank-looking spaces (no-break, ogham, U+2000-200A, narrow no-break, medium mathematical, ideographic) read as one ordinary
-- space. Trimmed: a text of nothing but spaces and the fillers above cleans to '' and is refused wherever the field needs a character.
create or replace function public.ads_clean_text(p_text text, p_multiline boolean) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select btrim(regexp_replace(regexp_replace(
           case when p_multiline
                then regexp_replace(coalesce(p_text, ''), '\r\n?', E'\n', 'g')
                else regexp_replace(coalesce(p_text, ''), '[\x09-\x0d\u2028\u2029]+', ' ', 'g') end,
           case when p_multiline
                then '[\x01-\x09\x0b-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]'
                else '[\x01-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]' end,
           '', 'g'),
           '[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]', ' ', 'g'), E' \n')
$$;

-- The same rule as a yes/no, for the checks on the tables: the text is already clean (what ads_clean_text would return: no character of the
-- class, no blank-looking space, nothing to trim) and within its length, so a text that needs a character holds one a person can see.
-- A check on the table is what holds for a writer that is not one of this file's functions.
create or replace function public.ads_text_ok(p_text text, p_min integer, p_max integer, p_multiline boolean) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_text is not null
     and char_length(p_text) between p_min and p_max
     and p_text = btrim(p_text, E' \n')
     and p_text !~ (case when p_multiline
                         then '[\x01-\x09\x0b-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]'
                         else '[\x01-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]' end)
     and p_text !~ '[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]'
$$;

-- A list of NAMES (font names): at most p_max, no null, no duplicate, each 1..p_len characters of letters, digits, space, dot, underscore,
-- apostrophe and hyphen, starting with a letter or digit. A name is a word a person reads; it is never a URL, a CSS value or a file.
create or replace function public.ads_text_list_ok(p_list text[], p_max integer, p_len integer) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_list is not null
     and coalesce(array_ndims(p_list), 1) = 1
     and coalesce(cardinality(p_list), 0) <= p_max
     and array_position(p_list, null) is null
     and (select count(distinct x) from unnest(p_list) x) = coalesce(cardinality(p_list), 0)
     and not exists (select 1 from unnest(p_list) x
                      where char_length(x) not between 1 and p_len or x !~ '^[A-Za-z0-9][A-Za-z0-9 ._''-]*$' or x <> btrim(x))
$$;

-- A palette: at most 8 colours, each exactly #rrggbb in lower case, no null, no duplicate. A colour is never any other CSS value.
create or replace function public.ads_palette_ok(p_list text[]) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_list is not null
     and coalesce(array_ndims(p_list), 1) = 1
     and coalesce(cardinality(p_list), 0) <= 8
     and array_position(p_list, null) is null
     and (select count(distinct x) from unnest(p_list) x) = coalesce(cardinality(p_list), 0)
     and not exists (select 1 from unnest(p_list) x where x !~ '^#[0-9a-f]{6}$')
$$;

-- A choice of words from a CLOSED list: between p_min and p_max of them, no null, no duplicate, every one in p_allowed.
create or replace function public.ads_closed_list_ok(p_list text[], p_allowed text[], p_min integer, p_max integer) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_list is not null
     and coalesce(array_ndims(p_list), 1) = 1
     and coalesce(cardinality(p_list), 0) between p_min and p_max
     and array_position(p_list, null) is null
     and (select count(distinct x) from unnest(p_list) x) = coalesce(cardinality(p_list), 0)
     and p_list <@ p_allowed
$$;

-- The site address is a NOTE. NULL (none), or https, a lower-case DNS name whose last label is letters (or punycode), then nothing or a path of
-- printable ASCII. So: no http, no user:password@, no port, no IP literal, no bare `localhost`, no blank, at most 300 characters. This is the
-- shape of what may be written down; it gives nothing permission to fetch it (Phase 2's scanner re-validates everything, at fetch time).
create or replace function public.ads_site_url_ok(p_url text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select p_url is null
      or (char_length(p_url) between 12 and 300
          and p_url ~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})(/[\x21-\x7e]*)?$')
$$;

-- Storyboard beats of a video concept: NULL (an image concept has none), or a list of 1..8 objects with exactly the keys `visual` (1..300
-- characters) and `line` (0..200), both clean single-line text, the whole at most 8192 bytes.
create or replace function public.ads_storyboard_ok(p_beats jsonb) returns boolean
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  b jsonb;
begin
  if p_beats is null then
    return true;
  end if;
  if jsonb_typeof(p_beats) <> 'array' or jsonb_array_length(p_beats) not between 1 and 8 or octet_length(p_beats::text) > 8192 then
    return false;
  end if;
  for b in select e from jsonb_array_elements(p_beats) e loop
    if jsonb_typeof(b) <> 'object'
       or (select count(*) from jsonb_object_keys(b)) <> 2
       or jsonb_typeof(b -> 'visual') is distinct from 'string'
       or jsonb_typeof(b -> 'line') is distinct from 'string'
       or not public.ads_text_ok(b ->> 'visual', 1, 300, false)
       or not public.ads_text_ok(b ->> 'line', 0, 200, false) then
      return false;
    end if;
  end loop;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.brand_kits (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  name          text not null,
  site_url      text,
  logo_asset_id uuid references public.media_assets (id) on delete set null,
  palette       text[] not null default '{}',
  fonts         text[] not null default '{}',
  voice_notes   text not null default '',
  source        text not null default 'manual',
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- The target of the children's composite foreign keys: a product or a campaign can only name a kit of the organization it says it belongs to.
  constraint brand_kits_id_org_key unique (id, org_id)
);

comment on table public.brand_kits is
  'A brand written down by a person (migration 0131, docs/ADS_FACTORY.md): name, site address as TEXT, a logo from the organization''s media library, colours, font names, voice notes. Written only by save_brand_kit / delete_brand_kit; members read.';
comment on column public.brand_kits.site_url is
  'A note: https and a DNS name, checked for shape only. Nothing in the database or the Command Center fetches it.';
comment on column public.brand_kits.fonts is
  'Font NAMES only (up to 4). No font file is stored, fetched or licensed by this row.';
comment on column public.brand_kits.source is
  'manual: a person typed it. scan: a draft the Phase 2 brand scanner proposed (no function of 0131 writes it).';

alter table public.brand_kits drop constraint if exists brand_kits_text_check;
alter table public.brand_kits add constraint brand_kits_text_check
  check (public.ads_text_ok(name, 1, 80, false)
         and public.ads_text_ok(voice_notes, 0, 1000, true)
         and public.ads_site_url_ok(site_url));
alter table public.brand_kits drop constraint if exists brand_kits_lists_check;
alter table public.brand_kits add constraint brand_kits_lists_check
  check (public.ads_palette_ok(palette) and public.ads_text_list_ok(fonts, 4, 60));
alter table public.brand_kits drop constraint if exists brand_kits_source_check;
alter table public.brand_kits add constraint brand_kits_source_check
  check (source in ('manual', 'scan'));

-- The cap counts these.
create index if not exists brand_kits_org_idx on public.brand_kits (org_id, created_at desc);
create index if not exists brand_kits_logo_idx on public.brand_kits (logo_asset_id) where logo_asset_id is not null;

create table if not exists public.brand_products (
  id          uuid primary key default gen_random_uuid(),
  kit_id      uuid not null,
  org_id      uuid not null,
  title       text not null,
  description text not null default '',
  price_text  text not null default '',
  source      text not null default 'manual',
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint brand_products_id_org_key unique (id, org_id),
  -- What a campaign's product row references: the product, its organization AND its kit, so a campaign can only pick products of its own kit.
  constraint brand_products_id_org_kit_key unique (id, org_id, kit_id),
  constraint brand_products_kit_fkey foreign key (kit_id, org_id)
    references public.brand_kits (id, org_id) on delete cascade
);

comment on table public.brand_products is
  'A product of a brand kit (migration 0131): title, description, price as TEXT. Written only by save_brand_product / delete_brand_product; members read.';
comment on column public.brand_products.price_text is
  'What a person typed ("$12", "from 99 000 so''m"). Text for display: never parsed, never used in arithmetic, never a claim the platform checked.';

alter table public.brand_products drop constraint if exists brand_products_text_check;
alter table public.brand_products add constraint brand_products_text_check
  check (public.ads_text_ok(title, 1, 120, false)
         and public.ads_text_ok(description, 0, 1000, true)
         and public.ads_text_ok(price_text, 0, 40, false));
alter table public.brand_products drop constraint if exists brand_products_source_check;
alter table public.brand_products add constraint brand_products_source_check
  check (source in ('manual', 'scan'));

create index if not exists brand_products_kit_idx on public.brand_products (kit_id, created_at);
create index if not exists brand_products_org_idx on public.brand_products (org_id);

create table if not exists public.brand_product_images (
  product_id uuid not null,
  org_id     uuid not null,
  asset_id   uuid not null references public.media_assets (id) on delete cascade,
  -- 0..3 and unique per product: no product can ever hold more than 4 pictures.
  position   smallint not null check (position between 0 and 3),
  created_at timestamptz not null default now(),
  primary key (product_id, asset_id),
  constraint brand_product_images_position_key unique (product_id, position),
  constraint brand_product_images_product_fkey foreign key (product_id, org_id)
    references public.brand_products (id, org_id) on delete cascade
);

comment on table public.brand_product_images is
  'A product''s pictures (migration 0131), in order. Same organization as the product (composite foreign key) and as the asset (trigger).';

create index if not exists brand_product_images_org_idx on public.brand_product_images (org_id);
create index if not exists brand_product_images_asset_idx on public.brand_product_images (asset_id);

create table if not exists public.ad_campaigns (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null,
  kit_id     uuid not null,
  name       text not null,
  objective  text not null,
  language   text not null,
  formats    text[] not null,
  directions text[] not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ad_campaigns_id_org_key unique (id, org_id),
  constraint ad_campaigns_id_org_kit_key unique (id, org_id, kit_id),
  -- Cascade, so an organization that is removed takes its campaigns with its kits. A PERSON cannot delete a kit that still has campaigns:
  -- delete_brand_kit refuses (kit_in_use), and no API role holds DELETE on brand_kits.
  constraint ad_campaigns_kit_fkey foreign key (kit_id, org_id)
    references public.brand_kits (id, org_id) on delete cascade
);

comment on table public.ad_campaigns is
  'An ad campaign of a brand kit (migration 0131): name, objective, language, formats and art directions from closed lists. Written only by save_ad_campaign / delete_ad_campaign; members read. A plan in words: it queues nothing and costs nothing.';

alter table public.ad_campaigns drop constraint if exists ad_campaigns_text_check;
alter table public.ad_campaigns add constraint ad_campaigns_text_check
  check (public.ads_text_ok(name, 1, 80, false));
alter table public.ad_campaigns drop constraint if exists ad_campaigns_choice_check;
alter table public.ad_campaigns add constraint ad_campaigns_choice_check
  check (objective in ('awareness', 'traffic', 'sales', 'launch', 'offer')
         and language in ('en', 'ru', 'uz')
         and public.ads_closed_list_ok(formats, array['1:1', '4:5', '9:16', '16:9'], 1, 4)
         and public.ads_closed_list_ok(directions, array['spotlight', 'editorial', 'minimal', 'lifestyle', 'bold'], 1, 3));

create index if not exists ad_campaigns_org_idx on public.ad_campaigns (org_id, created_at desc);
create index if not exists ad_campaigns_kit_idx on public.ad_campaigns (kit_id);

create table if not exists public.ad_campaign_products (
  campaign_id uuid not null,
  org_id      uuid not null,
  kit_id      uuid not null,
  product_id  uuid not null,
  -- 0..19 and unique per campaign: no campaign can ever name more than 20 products.
  position    smallint not null check (position between 0 and 19),
  created_at  timestamptz not null default now(),
  primary key (campaign_id, product_id),
  constraint ad_campaign_products_position_key unique (campaign_id, position),
  -- Both keys carry the organization AND the kit: the product of a campaign is, structurally, a product of that campaign's own kit.
  constraint ad_campaign_products_campaign_fkey foreign key (campaign_id, org_id, kit_id)
    references public.ad_campaigns (id, org_id, kit_id) on delete cascade,
  constraint ad_campaign_products_product_fkey foreign key (product_id, org_id, kit_id)
    references public.brand_products (id, org_id, kit_id) on delete cascade
);

comment on table public.ad_campaign_products is
  'The products a campaign advertises (migration 0131), in order. The composite foreign keys pin each to the campaign''s own kit and organization.';

create index if not exists ad_campaign_products_org_idx on public.ad_campaign_products (org_id);
create index if not exists ad_campaign_products_product_idx on public.ad_campaign_products (product_id);

create table if not exists public.ad_concepts (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null,
  org_id       uuid not null,
  product_id   uuid references public.brand_products (id) on delete set null,
  format       text not null,
  direction    text not null,
  kind         text not null,
  headline     text not null,
  body         text not null default '',
  cta          text not null default '',
  visual_brief text not null default '',
  storyboard   jsonb,
  status       text not null default 'draft',
  batch_key    text not null,
  batch_n      smallint not null,
  batch_hash   text not null,
  approved_by  uuid,
  approved_at  timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint ad_concepts_campaign_fkey foreign key (campaign_id, org_id)
    references public.ad_campaigns (id, org_id) on delete cascade
);

comment on table public.ad_concepts is
  'One ad concept draft (migration 0131): the words and the brief of one ad for one format. Written only by add_ad_concepts / update_ad_concept / set_ad_concept_status / delete_ad_concept; members read. TEMPLATE TEXT a person edits: no model wrote it, nobody checked its claims, and `approved` starts nothing.';
comment on column public.ad_concepts.visual_brief is
  'A description of the picture, for a person. It is not sent to any model by anything in 0131; a later phase must pass it through the prompt-safety path first.';
comment on column public.ad_concepts.batch_key is
  'The id of the press that added it (with batch_n, its place in that press): the same press again answers the first one instead of adding twice.';

alter table public.ad_concepts drop constraint if exists ad_concepts_choice_check;
alter table public.ad_concepts add constraint ad_concepts_choice_check
  check (format in ('1:1', '4:5', '9:16', '16:9')
         and direction in ('spotlight', 'editorial', 'minimal', 'lifestyle', 'bold')
         and kind in ('image', 'video'));
alter table public.ad_concepts drop constraint if exists ad_concepts_text_check;
alter table public.ad_concepts add constraint ad_concepts_text_check
  check (public.ads_text_ok(headline, 1, 120, false)
         and public.ads_text_ok(body, 0, 500, true)
         and public.ads_text_ok(cta, 0, 40, false)
         and public.ads_text_ok(visual_brief, 0, 1500, true));
alter table public.ad_concepts drop constraint if exists ad_concepts_storyboard_check;
alter table public.ad_concepts add constraint ad_concepts_storyboard_check
  check (((kind = 'image') = (storyboard is null)) and public.ads_storyboard_ok(storyboard));
alter table public.ad_concepts drop constraint if exists ad_concepts_status_check;
alter table public.ad_concepts add constraint ad_concepts_status_check
  check (status in ('draft', 'approved', 'archived')
         and ((status = 'approved' and approved_at is not null and approved_by is not null)
              or (status <> 'approved' and approved_at is null and approved_by is null)));
alter table public.ad_concepts drop constraint if exists ad_concepts_batch_check;
alter table public.ad_concepts add constraint ad_concepts_batch_check
  check (batch_key ~ '^[A-Za-z0-9_:.-]{8,128}$' and batch_n between 0 and 11 and batch_hash ~ '^[0-9a-f]{32}$');

-- One press, one set of rows: a replay finds the first press's rows instead of adding a second set.
create unique index if not exists ad_concepts_batch_key on public.ad_concepts (campaign_id, batch_key, batch_n);
create index if not exists ad_concepts_org_idx on public.ad_concepts (org_id);
create index if not exists ad_concepts_product_idx on public.ad_concepts (product_id) where product_id is not null;

-- The owner's numbers: one row, no API role has any privilege on it.
create table if not exists public.ads_factory_cap_settings (
  id                    boolean primary key default true,
  kits_per_org          integer not null default 5,
  products_per_kit      integer not null default 20,
  campaigns_per_org     integer not null default 20,
  concepts_per_campaign integer not null default 24,
  updated_at            timestamptz not null default now()
);

alter table public.ads_factory_cap_settings drop constraint if exists ads_factory_cap_settings_one_row;
alter table public.ads_factory_cap_settings add constraint ads_factory_cap_settings_one_row check (id);
alter table public.ads_factory_cap_settings drop constraint if exists ads_factory_cap_settings_numbers;
alter table public.ads_factory_cap_settings add constraint ads_factory_cap_settings_numbers
  check (kits_per_org between 0 and 100 and products_per_kit between 0 and 200
         and campaigns_per_org between 0 and 1000 and concepts_per_campaign between 0 and 200);

comment on table public.ads_factory_cap_settings is
  'One row (migration 0131): the most brand kits (kits_per_org, default 5) and campaigns (campaigns_per_org, default 20) one organization may hold, products one kit may hold (products_per_kit, default 20) and concepts one campaign may hold (concepts_per_campaign, default 24). 0 refuses every create of that kind. Read only by the save / add functions; changed in the SQL editor only, and a trigger leaves a mark in security_events.';

insert into public.ads_factory_cap_settings (id) values (true) on conflict (id) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Guards that hold for every writer
-- ───────────────────────────────────────────────────────────────────────────

-- A picture a kit or a product names is a live image of the row's own organization. Security definer so the check sees the asset whatever the
-- writer may read; the refusal is the same for "another organization's", "deleted", "not an image" and "no such asset".
create or replace function public.ads_asset_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_asset uuid;
begin
  if tg_table_name = 'brand_kits' then
    v_asset := new.logo_asset_id;
    -- An update that leaves the logo and the organization alone (a rename, or the asset's own soft delete long after) is not re-checked.
    if v_asset is null or (tg_op = 'UPDATE' and new.logo_asset_id is not distinct from old.logo_asset_id and new.org_id = old.org_id) then
      return new;
    end if;
  else
    v_asset := new.asset_id;
  end if;
  if not exists (
    select 1 from public.media_assets a
     where a.id = v_asset and a.org_id = new.org_id
       and a.kind = 'image' and a.deleted_at is null
  ) then
    raise exception 'invalid_reference'
      using errcode = 'NS400',
            detail = 'a picture must be a live image in the same organization''s library';
  end if;
  return new;
end
$$;

drop trigger if exists brand_kits_asset_guard on public.brand_kits;
create trigger brand_kits_asset_guard
  before insert or update on public.brand_kits
  for each row execute function public.ads_asset_guard();

drop trigger if exists brand_product_images_asset_guard on public.brand_product_images;
create trigger brand_product_images_asset_guard
  before insert or update on public.brand_product_images
  for each row execute function public.ads_asset_guard();

-- A concept's product is a product of its campaign's own kit, in the same organization, and its format and art direction are ones the campaign
-- chose WHEN THE ROW IS WRITTEN (a campaign that later drops a format keeps the concepts it already has). The product link is ON DELETE SET
-- NULL, so a concept outlives a deleted product and then names none.
create or replace function public.ad_concepts_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.ad_campaigns;
begin
  -- An update that keeps the concept where it is and names no NEW product has nothing to check: the words, the status, or the product link
  -- being cleared because its product was deleted (the campaign itself may already be gone in the same cascade).
  if tg_op = 'UPDATE' and new.campaign_id = old.campaign_id and new.org_id = old.org_id
     and (new.product_id is null or new.product_id is not distinct from old.product_id) then
    return new;
  end if;
  select * into c from public.ad_campaigns where id = new.campaign_id and org_id = new.org_id;
  if c.id is null then
    raise exception 'invalid_concept' using errcode = 'NS400', detail = 'reason=campaign';
  end if;
  if new.product_id is not null and not exists (
       select 1 from public.brand_products p
        where p.id = new.product_id and p.org_id = c.org_id and p.kit_id = c.kit_id) then
    raise exception 'invalid_concept' using errcode = 'NS400', detail = 'reason=product';
  end if;
  if tg_op = 'INSERT' and (not (new.format = any (c.formats)) or not (new.direction = any (c.directions))) then
    raise exception 'invalid_concept' using errcode = 'NS400', detail = 'reason=choice';
  end if;
  return new;
end
$$;

drop trigger if exists ad_concepts_guard on public.ad_concepts;
create trigger ad_concepts_guard
  before insert or update on public.ad_concepts
  for each row execute function public.ad_concepts_guard();

-- The settings row is edited (SQL editor), never deleted or emptied. A missing row would read as the defaults, which is the safe direction, but
-- the owner would not see why their numbers stopped applying.
create or replace function public.ads_factory_cap_settings_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'ads_factory_cap_settings keeps its one row' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists ads_factory_cap_settings_guard on public.ads_factory_cap_settings;
create trigger ads_factory_cap_settings_guard
  before update or delete on public.ads_factory_cap_settings
  for each row execute function public.ads_factory_cap_settings_guard();
drop trigger if exists ads_factory_cap_settings_no_truncate on public.ads_factory_cap_settings;
create trigger ads_factory_cap_settings_no_truncate
  before truncate on public.ads_factory_cap_settings
  for each statement execute function public.ads_factory_cap_settings_guard();

-- A change of a number (the SQL editor is the only way to make one) leaves a security_events row. It can never fail the write it observes: in an
-- emergency the owner must be able to lower a cap.
create or replace function public.ads_factory_cap_settings_trail() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  begin
    if new.kits_per_org is distinct from old.kits_per_org or new.products_per_kit is distinct from old.products_per_kit
       or new.campaigns_per_org is distinct from old.campaigns_per_org
       or new.concepts_per_campaign is distinct from old.concepts_per_campaign then
      perform public.security_event_log('ads.factory.caps', 'warning', 'ads_factory_cap_settings',
        jsonb_build_object('kits_per_org', jsonb_build_array(old.kits_per_org, new.kits_per_org),
                           'products_per_kit', jsonb_build_array(old.products_per_kit, new.products_per_kit),
                           'campaigns_per_org', jsonb_build_array(old.campaigns_per_org, new.campaigns_per_org),
                           'concepts_per_campaign', jsonb_build_array(old.concepts_per_campaign, new.concepts_per_campaign)));
    end if;
  exception when others then
    raise warning 'ads factory caps trail failed: %', sqlerrm;
  end;
  return null;
end
$$;

drop trigger if exists ads_factory_cap_settings_trail on public.ads_factory_cap_settings;
create trigger ads_factory_cap_settings_trail
  after update on public.ads_factory_cap_settings
  for each row execute function public.ads_factory_cap_settings_trail();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The picture list of a save, checked
-- ───────────────────────────────────────────────────────────────────────────

-- At most p_hi, no null, no duplicate, every id a live image of p_org. Raises the machine code; the same refusal whatever is wrong with an id.
create or replace function public.ads_check_images(p_org uuid, p_images uuid[], p_hi integer)
  returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  n integer := coalesce(cardinality(p_images), 0);
begin
  if n > p_hi then
    raise exception 'too_many_references' using errcode = 'NS400', detail = format('max=%s count=%s', p_hi, n);
  end if;
  if n = 0 then
    return;
  end if;
  if array_ndims(p_images) <> 1 or array_position(p_images, null) is not null then
    raise exception 'invalid_reference' using errcode = 'NS400';
  end if;
  if (select count(distinct a) from unnest(p_images) a) <> n then
    raise exception 'duplicate_reference' using errcode = 'NS400';
  end if;
  if (select count(*) from public.media_assets m
       where m.id = any (p_images) and m.org_id = p_org
         and m.kind = 'image' and m.deleted_at is null) <> n then
    raise exception 'invalid_reference'
      using errcode = 'NS400',
            detail = 'a picture must be a live image in the same organization''s library';
  end if;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Brand kits
-- ───────────────────────────────────────────────────────────────────────────

-- LOCK ORDER (every function below that writes a kit, a product or a campaign): first the row it changes, FOR NO KEY UPDATE; then the
-- organization's advisory lock (pg_advisory_xact_lock(hashtextextended('ads_factory:' || org, 0))); then the writes. A row lock taken
-- before the organization's lock must never block FOR KEY SHARE, the lock the foreign key check of an insert takes on its parent row:
-- the writer that holds the organization's lock may be inserting a child of that very row (a concept of the campaign, a product of the
-- kit, a campaign line naming the product), and a FOR UPDATE here made the two wait for each other (40P01). A delete upgrades its row
-- lock only under the organization's lock, when no such insert can be running. The concept functions lock one concept row, which
-- nothing references, and take no organization lock. tests/security/test_sec_ads_factory.py races every pair.

-- p_kit null: create a kit in p_org. p_kit set: replace that kit's fields (its organization is the kit's own; p_org, if given, must agree).
-- Returns the kit id.
create or replace function public.save_brand_kit(
  p_org uuid, p_kit uuid, p_name text, p_site_url text, p_logo uuid, p_palette text[], p_fonts text[], p_voice text
) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k        public.brand_kits;
  v_org    uuid := p_org;
  v_name   text;
  v_url    text;
  v_voice  text;
  v_pal    text[];
  v_fonts  text[];
  v_cap    integer;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_kit is not null then
    select * into k from public.brand_kits where id = p_kit for no key update;
    -- Another organization's kit reads as missing, never as "forbidden".
    if not found or not public.is_org_member(k.org_id) or (p_org is not null and p_org <> k.org_id) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    v_org := k.org_id;
  end if;
  if v_org is null or not public.is_org_member(v_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Cleaned only now: nothing a caller sends is worked on before sign-in and membership are checked.
  v_name  := public.ads_clean_text(p_name, false);
  v_url   := nullif(btrim(coalesce(p_site_url, '')), '');
  v_voice := public.ads_clean_text(p_voice, true);
  if char_length(v_name) not between 1 and 80 then
    raise exception 'invalid_name' using errcode = 'NS400', detail = 'max=80';
  end if;
  if not public.ads_site_url_ok(v_url) then
    raise exception 'invalid_site_url' using errcode = 'NS400';
  end if;
  if char_length(v_voice) > 1000 then
    raise exception 'invalid_voice' using errcode = 'NS400', detail = 'max=1000';
  end if;
  -- Colours are stored lower-case; a NULL list is an empty one. Anything that is not exactly #rrggbb is refused, not repaired.
  select coalesce(array_agg(lower(x) order by o), '{}') into v_pal from unnest(coalesce(p_palette, '{}')) with ordinality u(x, o);
  if coalesce(array_ndims(p_palette), 1) <> 1 or not public.ads_palette_ok(v_pal) then
    raise exception 'invalid_palette' using errcode = 'NS400', detail = 'max=8';
  end if;
  select coalesce(array_agg(public.ads_clean_text(x, false) order by o), '{}') into v_fonts
    from unnest(coalesce(p_fonts, '{}')) with ordinality u(x, o);
  if coalesce(array_ndims(p_fonts), 1) <> 1 or not public.ads_text_list_ok(v_fonts, 4, 60) then
    raise exception 'invalid_fonts' using errcode = 'NS400', detail = 'max=4';
  end if;
  if p_logo is not null then
    perform public.ads_check_images(v_org, array[p_logo], 1);
  end if;

  -- One writer per organization at a time: the caps hold under parallel requests.
  perform pg_advisory_xact_lock(hashtextextended('ads_factory:' || v_org::text, 0));

  if p_kit is null then
    select s.kits_per_org into v_cap from public.ads_factory_cap_settings s;
    v_cap := coalesce(v_cap, 5);
    if (select count(*) from public.brand_kits where org_id = v_org) >= v_cap then
      raise exception 'limit_reached' using errcode = 'NS429', detail = format('max=%s', v_cap);
    end if;
    insert into public.brand_kits (org_id, name, site_url, logo_asset_id, palette, fonts, voice_notes, source, created_by)
    values (v_org, v_name, v_url, p_logo, v_pal, v_fonts, v_voice, 'manual', auth.uid())
    returning * into k;
  else
    update public.brand_kits
       set name = v_name, site_url = v_url, logo_asset_id = p_logo, palette = v_pal, fonts = v_fonts, voice_notes = v_voice, updated_at = now()
     where id = k.id
    returning * into k;
  end if;
  return k.id;
end
$$;

-- Delete a kit with its products. Refused while a campaign still uses it (kit_in_use): a campaign's concepts are a person's work, and they
-- are deleted by deleting the campaign, on purpose, not as a side effect.
create or replace function public.delete_brand_kit(p_kit uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k public.brand_kits;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into k from public.brand_kits where id = p_kit for no key update;
  if not found or not public.is_org_member(k.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(k.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ads_factory:' || k.org_id::text, 0));
  if exists (select 1 from public.ad_campaigns where kit_id = k.id) then
    raise exception 'kit_in_use' using errcode = 'NS409';
  end if;
  delete from public.brand_kits where id = k.id;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Brand products
-- ───────────────────────────────────────────────────────────────────────────

-- p_product null: add a product to p_kit. p_product set: replace it and its pictures (its kit is the product's own; p_kit, if given, must
-- agree). Returns the product id.
create or replace function public.save_brand_product(
  p_kit uuid, p_product uuid, p_title text, p_description text, p_price text, p_images uuid[]
) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k        public.brand_kits;
  pr       public.brand_products;
  v_kit    uuid := p_kit;
  v_title  text;
  v_desc   text;
  v_price  text;
  v_cap    integer;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_product is not null then
    select * into pr from public.brand_products where id = p_product for no key update;
    if not found or not public.is_org_member(pr.org_id) or (p_kit is not null and p_kit <> pr.kit_id) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    v_kit := pr.kit_id;
  end if;
  select * into k from public.brand_kits where id = v_kit;
  if k.id is null or not public.is_org_member(k.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(k.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Cleaned only now, after sign-in and membership.
  v_title := public.ads_clean_text(p_title, false);
  v_desc  := public.ads_clean_text(p_description, true);
  v_price := public.ads_clean_text(p_price, false);
  if char_length(v_title) not between 1 and 120 then
    raise exception 'invalid_title' using errcode = 'NS400', detail = 'max=120';
  end if;
  if char_length(v_desc) > 1000 then
    raise exception 'invalid_description' using errcode = 'NS400', detail = 'max=1000';
  end if;
  if char_length(v_price) > 40 then
    raise exception 'invalid_price' using errcode = 'NS400', detail = 'max=40';
  end if;
  perform public.ads_check_images(k.org_id, p_images, 4);

  perform pg_advisory_xact_lock(hashtextextended('ads_factory:' || k.org_id::text, 0));

  if p_product is null then
    select s.products_per_kit into v_cap from public.ads_factory_cap_settings s;
    v_cap := coalesce(v_cap, 20);
    if (select count(*) from public.brand_products where kit_id = k.id) >= v_cap then
      raise exception 'limit_reached' using errcode = 'NS429', detail = format('max=%s', v_cap);
    end if;
    insert into public.brand_products (kit_id, org_id, title, description, price_text, source, created_by)
    values (k.id, k.org_id, v_title, v_desc, v_price, 'manual', auth.uid())
    returning * into pr;
  else
    update public.brand_products set title = v_title, description = v_desc, price_text = v_price, updated_at = now()
     where id = pr.id
    returning * into pr;
    delete from public.brand_product_images where product_id = pr.id;
  end if;

  insert into public.brand_product_images (product_id, org_id, asset_id, position)
  select pr.id, k.org_id, u.a, (u.o - 1)::smallint
    from unnest(coalesce(p_images, '{}')) with ordinality as u(a, o);

  return pr.id;
end
$$;

-- Delete a product. Campaigns that advertised it lose it from their list, and concepts written for it stay, naming no product.
create or replace function public.delete_brand_product(p_product uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  pr public.brand_products;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into pr from public.brand_products where id = p_product for no key update;
  if not found or not public.is_org_member(pr.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(pr.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The delete (and the campaign rows it takes with it) waits for any writer of the organization that is linking this product right now.
  perform pg_advisory_xact_lock(hashtextextended('ads_factory:' || pr.org_id::text, 0));
  delete from public.brand_products where id = pr.id;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Campaigns
-- ───────────────────────────────────────────────────────────────────────────

-- p_campaign null: create a campaign for p_kit. p_campaign set: replace its fields and its product list (its kit is the campaign's own and
-- cannot be changed; p_kit, if given, must agree). Every choice is from a closed list; every product is one of the kit's. Returns the id.
create or replace function public.save_ad_campaign(
  p_kit uuid, p_campaign uuid, p_name text, p_objective text, p_language text, p_formats text[], p_directions text[], p_products uuid[]
) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k       public.brand_kits;
  c       public.ad_campaigns;
  v_kit   uuid := p_kit;
  v_name  text;
  n       integer := coalesce(cardinality(p_products), 0);
  v_cap   integer;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_campaign is not null then
    select * into c from public.ad_campaigns where id = p_campaign for no key update;
    if not found or not public.is_org_member(c.org_id) or (p_kit is not null and p_kit <> c.kit_id) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    v_kit := c.kit_id;
  end if;
  select * into k from public.brand_kits where id = v_kit;
  if k.id is null or not public.is_org_member(k.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(k.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Cleaned only now, after sign-in and membership.
  v_name := public.ads_clean_text(p_name, false);
  if char_length(v_name) not between 1 and 80 then
    raise exception 'invalid_name' using errcode = 'NS400', detail = 'max=80';
  end if;
  -- Closed lists, compared exactly: not trimmed, not lower-cased, not defaulted. An unknown word is refused, never read as a default.
  if p_objective is null or p_objective not in ('awareness', 'traffic', 'sales', 'launch', 'offer') then
    raise exception 'invalid_objective' using errcode = 'NS400';
  end if;
  if p_language is null or p_language not in ('en', 'ru', 'uz') then
    raise exception 'invalid_language' using errcode = 'NS400';
  end if;
  if p_formats is null or not public.ads_closed_list_ok(p_formats, array['1:1', '4:5', '9:16', '16:9'], 1, 4) then
    raise exception 'invalid_formats' using errcode = 'NS400';
  end if;
  if p_directions is null or not public.ads_closed_list_ok(p_directions, array['spotlight', 'editorial', 'minimal', 'lifestyle', 'bold'], 1, 3) then
    raise exception 'invalid_directions' using errcode = 'NS400';
  end if;
  -- 1..20 products, each one of THIS kit's. Another kit's, another organization's and a made-up id are the same refusal.
  if n not between 1 and 20 or array_ndims(p_products) <> 1 or array_position(p_products, null) is not null
     or (select count(distinct x) from unnest(p_products) x) <> n
     or (select count(*) from public.brand_products p where p.id = any (p_products) and p.kit_id = k.id and p.org_id = k.org_id) <> n then
    raise exception 'invalid_products' using errcode = 'NS400', detail = 'min=1 max=20';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ads_factory:' || k.org_id::text, 0));

  if p_campaign is null then
    select s.campaigns_per_org into v_cap from public.ads_factory_cap_settings s;
    v_cap := coalesce(v_cap, 20);
    if (select count(*) from public.ad_campaigns where org_id = k.org_id) >= v_cap then
      raise exception 'limit_reached' using errcode = 'NS429', detail = format('max=%s', v_cap);
    end if;
    insert into public.ad_campaigns (org_id, kit_id, name, objective, language, formats, directions, created_by)
    values (k.org_id, k.id, v_name, p_objective, p_language, p_formats, p_directions, auth.uid())
    returning * into c;
  else
    update public.ad_campaigns
       set name = v_name, objective = p_objective, language = p_language, formats = p_formats, directions = p_directions, updated_at = now()
     where id = c.id
    returning * into c;
    delete from public.ad_campaign_products where campaign_id = c.id;
  end if;

  insert into public.ad_campaign_products (campaign_id, org_id, kit_id, product_id, position)
  select c.id, c.org_id, c.kit_id, u.p, (u.o - 1)::smallint
    from unnest(p_products) with ordinality as u(p, o);

  return c.id;
end
$$;

-- Delete a campaign with its concepts (approved ones included: in 0131 an approved concept is words, and nothing was made from it).
create or replace function public.delete_ad_campaign(p_campaign uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  c public.ad_campaigns;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into c from public.ad_campaigns where id = p_campaign for no key update;
  if not found or not public.is_org_member(c.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(c.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The delete waits for a press that is adding concepts to this campaign right now, instead of failing it half-way.
  perform pg_advisory_xact_lock(hashtextextended('ads_factory:' || c.org_id::text, 0));
  delete from public.ad_campaigns where id = c.id;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Concepts
-- ───────────────────────────────────────────────────────────────────────────

-- Add 1..12 concept drafts to a campaign in ONE press (p_batch is the id of the press). Each element of p_concepts is an object with EXACTLY
-- the keys product_id, format, direction, kind, headline, body, cta, visual_brief, storyboard. The Command Center fills them from fixed templates
-- (lib/adsFactory/concepts.ts: no model call); this function trusts none of it: every text is cleaned and length-checked again, the format and
-- the art direction must be ones the campaign chose, the product must be one the campaign advertises, and the campaign's cap is counted here.
-- The same press again (a double click, a retry) answers the first one's rows with replayed = true and adds nothing; the same key with other
-- content is idempotency_conflict. Returns {ids, replayed}.
create or replace function public.add_ad_concepts(p_campaign uuid, p_batch text, p_concepts jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  c        public.ad_campaigns;
  e        jsonb;
  b        jsonb;
  i        integer := 0;
  n        integer;
  v_hash   text;
  v_prior  text;
  v_cap    integer;
  v_have   integer;
  v_prod   uuid;
  v_kind   text;
  v_beats  jsonb;
  v_head   text;
  v_body   text;
  v_cta    text;
  v_brief  text;
  v_id     uuid;
  v_ids    uuid[] := '{}';
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into c from public.ad_campaigns where id = p_campaign;
  if c.id is null or not public.is_org_member(c.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(c.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_batch is null or p_batch !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = 'NS400';
  end if;
  if p_concepts is null or jsonb_typeof(p_concepts) <> 'array' or jsonb_array_length(p_concepts) not between 1 and 12
     or octet_length(p_concepts::text) > 131072 then
    raise exception 'invalid_concepts' using errcode = 'NS400', detail = 'min=1 max=12';
  end if;
  n := jsonb_array_length(p_concepts);
  v_hash := md5(p_concepts::text);

  perform pg_advisory_xact_lock(hashtextextended('ads_factory:' || c.org_id::text, 0));

  select batch_hash into v_prior from public.ad_concepts where campaign_id = c.id and batch_key = p_batch limit 1;
  if v_prior is not null then
    if v_prior <> v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    -- The same press again: its rows (those that still exist), nothing added twice.
    return jsonb_build_object('replayed', true, 'ids',
      (select coalesce(jsonb_agg(x.id order by x.batch_n), '[]'::jsonb) from public.ad_concepts x where x.campaign_id = c.id and x.batch_key = p_batch));
  end if;

  select s.concepts_per_campaign into v_cap from public.ads_factory_cap_settings s;
  v_cap := coalesce(v_cap, 24);
  select count(*) into v_have from public.ad_concepts where campaign_id = c.id;
  if v_have + n > v_cap then
    raise exception 'limit_reached' using errcode = 'NS429', detail = format('max=%s have=%s', v_cap, v_have);
  end if;

  for e in select x from jsonb_array_elements(p_concepts) x loop
    if jsonb_typeof(e) <> 'object'
       or exists (select 1 from jsonb_object_keys(e) k
                   where k not in ('product_id', 'format', 'direction', 'kind', 'headline', 'body', 'cta', 'visual_brief', 'storyboard'))
       or jsonb_typeof(e -> 'format') is distinct from 'string' or jsonb_typeof(e -> 'direction') is distinct from 'string'
       or jsonb_typeof(e -> 'kind') is distinct from 'string' or jsonb_typeof(e -> 'headline') is distinct from 'string'
       or coalesce(jsonb_typeof(e -> 'body'), 'string') <> 'string' or coalesce(jsonb_typeof(e -> 'cta'), 'string') <> 'string'
       or coalesce(jsonb_typeof(e -> 'visual_brief'), 'string') <> 'string'
       or coalesce(jsonb_typeof(e -> 'product_id'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(e -> 'storyboard'), 'null') not in ('array', 'null') then
      raise exception 'invalid_concept' using errcode = 'NS400', detail = format('n=%s reason=shape', i);
    end if;
    v_kind := e ->> 'kind';
    if v_kind not in ('image', 'video')
       or not ((e ->> 'format') = any (c.formats))
       or not ((e ->> 'direction') = any (c.directions)) then
      raise exception 'invalid_concept' using errcode = 'NS400', detail = format('n=%s reason=choice', i);
    end if;
    v_prod := null;
    if jsonb_typeof(e -> 'product_id') = 'string' then
      if (e ->> 'product_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'invalid_concept' using errcode = 'NS400', detail = format('n=%s reason=product', i);
      end if;
      v_prod := (e ->> 'product_id')::uuid;
      -- One of the products THIS campaign advertises; another kit's, another organization's and a made-up id are the same refusal.
      if not exists (select 1 from public.ad_campaign_products cp where cp.campaign_id = c.id and cp.product_id = v_prod) then
        raise exception 'invalid_concept' using errcode = 'NS400', detail = format('n=%s reason=product', i);
      end if;
    end if;
    v_head  := public.ads_clean_text(e ->> 'headline', false);
    v_body  := public.ads_clean_text(e ->> 'body', true);
    v_cta   := public.ads_clean_text(e ->> 'cta', false);
    v_brief := public.ads_clean_text(e ->> 'visual_brief', true);
    if char_length(v_head) not between 1 and 120 or char_length(v_body) > 500 or char_length(v_cta) > 40 or char_length(v_brief) > 1500 then
      raise exception 'invalid_concept' using errcode = 'NS400', detail = format('n=%s reason=text', i);
    end if;
    v_beats := null;
    if v_kind = 'video' then
      if jsonb_typeof(e -> 'storyboard') is distinct from 'array' or jsonb_array_length(e -> 'storyboard') not between 1 and 8 then
        raise exception 'invalid_concept' using errcode = 'NS400', detail = format('n=%s reason=storyboard', i);
      end if;
      v_beats := '[]'::jsonb;
      for b in select x from jsonb_array_elements(e -> 'storyboard') x loop
        if jsonb_typeof(b) <> 'object' or exists (select 1 from jsonb_object_keys(b) k where k not in ('visual', 'line'))
           or jsonb_typeof(b -> 'visual') is distinct from 'string' or coalesce(jsonb_typeof(b -> 'line'), 'string') <> 'string' then
          raise exception 'invalid_concept' using errcode = 'NS400', detail = format('n=%s reason=storyboard', i);
        end if;
        v_beats := v_beats || jsonb_build_array(jsonb_build_object(
          'visual', public.ads_clean_text(b ->> 'visual', false), 'line', public.ads_clean_text(b ->> 'line', false)));
      end loop;
      if not public.ads_storyboard_ok(v_beats) then
        raise exception 'invalid_concept' using errcode = 'NS400', detail = format('n=%s reason=storyboard', i);
      end if;
    elsif jsonb_typeof(e -> 'storyboard') = 'array' then
      raise exception 'invalid_concept' using errcode = 'NS400', detail = format('n=%s reason=storyboard', i);
    end if;

    insert into public.ad_concepts (campaign_id, org_id, product_id, format, direction, kind, headline, body, cta, visual_brief, storyboard,
                                    status, batch_key, batch_n, batch_hash, created_by)
    values (c.id, c.org_id, v_prod, e ->> 'format', e ->> 'direction', v_kind, v_head, v_body, v_cta, v_brief, v_beats,
            'draft', p_batch, i, v_hash, auth.uid())
    returning id into v_id;
    v_ids := v_ids || v_id;
    i := i + 1;
  end loop;

  return jsonb_build_object('replayed', false, 'ids', to_jsonb(v_ids));
end
$$;

-- Edit the words of a DRAFT. An approved or archived concept is not edited in place (concept_not_draft): the words a person approved stay the
-- words they approved until someone sends the concept back to draft. The storyboard of an image concept is always NULL; a video concept keeps
-- 1..8 beats.
create or replace function public.update_ad_concept(
  p_concept uuid, p_headline text, p_body text, p_cta text, p_visual_brief text, p_storyboard jsonb
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  x        public.ad_concepts;
  b        jsonb;
  v_head   text;
  v_body   text;
  v_cta    text;
  v_brief  text;
  v_beats  jsonb;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into x from public.ad_concepts where id = p_concept for update;
  if not found or not public.is_org_member(x.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(x.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if x.status <> 'draft' then
    raise exception 'concept_not_draft' using errcode = 'NS409';
  end if;
  -- Cleaned only now, after sign-in, membership and the status.
  v_head  := public.ads_clean_text(p_headline, false);
  v_body  := public.ads_clean_text(p_body, true);
  v_cta   := public.ads_clean_text(p_cta, false);
  v_brief := public.ads_clean_text(p_visual_brief, true);
  if char_length(v_head) not between 1 and 120 then
    raise exception 'invalid_headline' using errcode = 'NS400', detail = 'max=120';
  end if;
  if char_length(v_body) > 500 then
    raise exception 'invalid_body' using errcode = 'NS400', detail = 'max=500';
  end if;
  if char_length(v_cta) > 40 then
    raise exception 'invalid_cta' using errcode = 'NS400', detail = 'max=40';
  end if;
  if char_length(v_brief) > 1500 then
    raise exception 'invalid_visual_brief' using errcode = 'NS400', detail = 'max=1500';
  end if;
  if x.kind = 'image' then
    if p_storyboard is not null and jsonb_typeof(p_storyboard) <> 'null' then
      raise exception 'invalid_storyboard' using errcode = 'NS400';
    end if;
    v_beats := null;
  else
    if p_storyboard is null or jsonb_typeof(p_storyboard) <> 'array' or jsonb_array_length(p_storyboard) not between 1 and 8 then
      raise exception 'invalid_storyboard' using errcode = 'NS400', detail = 'min=1 max=8';
    end if;
    v_beats := '[]'::jsonb;
    for b in select e from jsonb_array_elements(p_storyboard) e loop
      if jsonb_typeof(b) <> 'object' or exists (select 1 from jsonb_object_keys(b) k where k not in ('visual', 'line'))
         or jsonb_typeof(b -> 'visual') is distinct from 'string' or coalesce(jsonb_typeof(b -> 'line'), 'string') <> 'string' then
        raise exception 'invalid_storyboard' using errcode = 'NS400';
      end if;
      v_beats := v_beats || jsonb_build_array(jsonb_build_object(
        'visual', public.ads_clean_text(b ->> 'visual', false), 'line', public.ads_clean_text(b ->> 'line', false)));
    end loop;
    if not public.ads_storyboard_ok(v_beats) then
      raise exception 'invalid_storyboard' using errcode = 'NS400';
    end if;
  end if;

  update public.ad_concepts
     set headline = v_head, body = v_body, cta = v_cta, visual_brief = v_brief, storyboard = v_beats, updated_at = now()
   where id = x.id;
  return true;
end
$$;

-- Move a concept between draft, approved and archived. Approving records who and when; leaving `approved` clears both. An archived concept
-- goes back to draft before it can be approved (invalid_transition), so an approval is always of words someone just looked at as a draft.
-- Asking for the status it already has changes nothing and is not an error (a double click). Approving STARTS NOTHING and costs nothing.
create or replace function public.set_ad_concept_status(p_concept uuid, p_status text) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  x public.ad_concepts;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into x from public.ad_concepts where id = p_concept for update;
  if not found or not public.is_org_member(x.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(x.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('draft', 'approved', 'archived') then
    raise exception 'invalid_status' using errcode = 'NS400';
  end if;
  if x.status = p_status then
    return x.status;
  end if;
  if x.status = 'archived' and p_status = 'approved' then
    raise exception 'invalid_transition' using errcode = 'NS409';
  end if;
  update public.ad_concepts
     set status = p_status,
         approved_by = case when p_status = 'approved' then auth.uid() else null end,
         approved_at = case when p_status = 'approved' then now() else null end,
         updated_at = now()
   where id = x.id;
  return p_status;
end
$$;

-- Delete one concept (any status: in 0131 nothing was made from it). It frees one place under the campaign's cap.
create or replace function public.delete_ad_concept(p_concept uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  x public.ad_concepts;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into x from public.ad_concepts where id = p_concept for update;
  if not found or not public.is_org_member(x.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(x.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.ad_concepts where id = x.id;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. RLS and grants: a member reads; nobody writes through the API
-- ───────────────────────────────────────────────────────────────────────────

alter table public.brand_kits enable row level security;
alter table public.brand_products enable row level security;
alter table public.brand_product_images enable row level security;
alter table public.ad_campaigns enable row level security;
alter table public.ad_campaign_products enable row level security;
alter table public.ad_concepts enable row level security;
alter table public.ads_factory_cap_settings enable row level security;

-- Rows change only through the functions above: no direct write for anyone, the service key included (it bypasses RLS, not privileges).
revoke all on public.brand_kits, public.brand_products, public.brand_product_images, public.ad_campaigns, public.ad_campaign_products,
              public.ad_concepts, public.ads_factory_cap_settings
  from public, anon, authenticated, service_role;
grant select on public.brand_kits, public.brand_products, public.brand_product_images, public.ad_campaigns, public.ad_campaign_products,
                public.ad_concepts
  to authenticated, service_role;

drop policy if exists brand_kits_select on public.brand_kits;
create policy brand_kits_select on public.brand_kits
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists brand_products_select on public.brand_products;
create policy brand_products_select on public.brand_products
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists brand_product_images_select on public.brand_product_images;
create policy brand_product_images_select on public.brand_product_images
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists ad_campaigns_select on public.ad_campaigns;
create policy ad_campaigns_select on public.ad_campaigns
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists ad_campaign_products_select on public.ad_campaign_products;
create policy ad_campaign_products_select on public.ad_campaign_products
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists ad_concepts_select on public.ad_concepts;
create policy ad_concepts_select on public.ad_concepts
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

-- Functions: revoke from everyone, then grant the ten a member calls to signed-in users only (each checks membership and role itself).
revoke all on function public.ads_clean_text(text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.ads_text_ok(text, integer, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function public.ads_text_list_ok(text[], integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.ads_palette_ok(text[]) from public, anon, authenticated, service_role;
revoke all on function public.ads_closed_list_ok(text[], text[], integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.ads_site_url_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.ads_storyboard_ok(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.ads_check_images(uuid, uuid[], integer) from public, anon, authenticated, service_role;
revoke all on function public.ads_asset_guard() from public, anon, authenticated, service_role;
revoke all on function public.ad_concepts_guard() from public, anon, authenticated, service_role;
revoke all on function public.ads_factory_cap_settings_guard() from public, anon, authenticated, service_role;
revoke all on function public.ads_factory_cap_settings_trail() from public, anon, authenticated, service_role;
revoke all on function public.save_brand_kit(uuid, uuid, text, text, uuid, text[], text[], text) from public, anon, authenticated, service_role;
revoke all on function public.delete_brand_kit(uuid) from public, anon, authenticated, service_role;
revoke all on function public.save_brand_product(uuid, uuid, text, text, text, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.delete_brand_product(uuid) from public, anon, authenticated, service_role;
revoke all on function public.save_ad_campaign(uuid, uuid, text, text, text, text[], text[], uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.delete_ad_campaign(uuid) from public, anon, authenticated, service_role;
revoke all on function public.add_ad_concepts(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.update_ad_concept(uuid, text, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.set_ad_concept_status(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.delete_ad_concept(uuid) from public, anon, authenticated, service_role;

grant execute on function public.save_brand_kit(uuid, uuid, text, text, uuid, text[], text[], text) to authenticated;
grant execute on function public.delete_brand_kit(uuid) to authenticated;
grant execute on function public.save_brand_product(uuid, uuid, text, text, text, uuid[]) to authenticated;
grant execute on function public.delete_brand_product(uuid) to authenticated;
grant execute on function public.save_ad_campaign(uuid, uuid, text, text, text, text[], text[], uuid[]) to authenticated;
grant execute on function public.delete_ad_campaign(uuid) to authenticated;
grant execute on function public.add_ad_concepts(uuid, text, jsonb) to authenticated;
grant execute on function public.update_ad_concept(uuid, text, text, text, text, jsonb) to authenticated;
grant execute on function public.set_ad_concept_status(uuid, text) to authenticated;
grant execute on function public.delete_ad_concept(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 10. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
-- If any of this is false the whole file rolls back (apply as one transaction). It restates the pins above: every function holds this file's
-- body, the ten member functions are executable by `authenticated` and by nobody else, the twelve internal ones by nobody, every table has row
-- level security, the six content tables have exactly their one SELECT policy and the settings none, no API role holds a write privilege on any
-- of them, anon holds nothing, the settings hold their one row, and every check and trigger is in place.
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
      ('public.ads_clean_text(text, boolean)', '53ecd0c6309be86c4e134da323146e61', false),
      ('public.ads_text_ok(text, integer, integer, boolean)', '78ebe62fa220880ef2494563ab6cad99', false),
      ('public.ads_text_list_ok(text[], integer, integer)', '3a5bd8e451a350dd799c9b49f6bb5061', false),
      ('public.ads_palette_ok(text[])', '94dfa0449defc9f2907f6e7ba9a00243', false),
      ('public.ads_closed_list_ok(text[], text[], integer, integer)', 'd932104160cc4768d10342395e74128d', false),
      ('public.ads_site_url_ok(text)', '798012d1ead26b8383414e2720740fe9', false),
      ('public.ads_storyboard_ok(jsonb)', 'b4576417d2448f8478888786eff3d912', false),
      ('public.ads_check_images(uuid, uuid[], integer)', 'db5500a074148d993bd0a677720e7aae', false),
      ('public.ads_asset_guard()', '3d8efe4d0763c2d88f35b54da1cfd025', false),
      ('public.ad_concepts_guard()', '8f2f17776e0e93af231a1aec923ead88', false),
      ('public.ads_factory_cap_settings_guard()', '51dafe4ec2c9f35974e9ff8289a6106b', false),
      ('public.ads_factory_cap_settings_trail()', '986d228f1ab027e44e8a6837a1a49b3e', false),
      ('public.save_brand_kit(uuid, uuid, text, text, uuid, text[], text[], text)', 'c6d162ea7c8abd3fa78243a1b3b6ae88', true),
      ('public.delete_brand_kit(uuid)', '38a605d9ff0aa9a8d49526c5f0e32733', true),
      ('public.save_brand_product(uuid, uuid, text, text, text, uuid[])', '16de653c6557c7be611d4a6be2eeabd6', true),
      ('public.delete_brand_product(uuid)', '7f1f41e614b47c3762cc49a08867a39d', true),
      ('public.save_ad_campaign(uuid, uuid, text, text, text, text[], text[], uuid[])', '05765d4994fc9a9a0bf0f090f7692b23', true),
      ('public.delete_ad_campaign(uuid)', 'f40f5bd45d120c36e095a5a659cdd347', true),
      ('public.add_ad_concepts(uuid, text, jsonb)', 'ef6ece5fadc12da31a3706be99095263', true),
      ('public.update_ad_concept(uuid, text, text, text, text, jsonb)', '92f3faa8775c9cceb6d867d632567002', true),
      ('public.set_ad_concept_status(uuid, text)', '0f4a08254f801319c12718f319dfa612', true),
      ('public.delete_ad_concept(uuid)', '821913088f82cc84b7aba3398c5bf029', true)
    ) v(sig, want, member)
  loop
    fn := to_regprocedure(r.sig);
    if fn is null then
      raise exception '0131 end state: % does not exist', r.sig;
    end if;
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = fn;
    if got <> r.want then
      raise exception '0131 end state: % does not hold this file''s body (md5 %)', r.sig, got;
    end if;
    -- A NULL ACL would mean "default privileges", and the default includes public.
    if exists (select 1 from pg_proc p
                where p.oid = fn
                  and (p.proacl is null
                       or exists (select 1 from aclexplode(p.proacl) a
                                   where a.grantee = 0
                                      or a.grantee in (select o.oid from pg_roles o where o.rolname in ('anon', 'service_role'))
                                      or (not r.member and a.grantee in (select o.oid from pg_roles o where o.rolname = 'authenticated'))))) then
      raise exception '0131 end state: % is executable by a role that must not call it', r.sig;
    end if;
    if r.member and not has_function_privilege('authenticated', fn, 'execute') then
      raise exception '0131 end state: % is not executable by authenticated', r.sig;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = fn and p.proconfig @> array['search_path=public, pg_temp']) then
      raise exception '0131 end state: % has no pinned search_path', r.sig;
    end if;
  end loop;
  -- One function per name: no overload of a member function was left behind by an earlier draft.
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('save_brand_kit', 'delete_brand_kit', 'save_brand_product', 'delete_brand_product', 'save_ad_campaign',
                          'delete_ad_campaign', 'add_ad_concepts', 'update_ad_concept', 'set_ad_concept_status', 'delete_ad_concept')) <> 10 then
    raise exception '0131 end state: a member function has an overload';
  end if;

  foreach t in array array['brand_kits', 'brand_products', 'brand_product_images', 'ad_campaigns', 'ad_campaign_products', 'ad_concepts',
                           'ads_factory_cap_settings'] loop
    if not exists (select 1 from pg_class where oid = ('public.' || t)::regclass and relrowsecurity) then
      raise exception '0131 end state: % has no row level security', t;
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      foreach priv in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
        if has_table_privilege(role_name, 'public.' || t, priv) then
          raise exception '0131 end state: % holds % on %', role_name, priv, t;
        end if;
      end loop;
    end loop;
    if has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception '0131 end state: anon reads %', t;
    end if;
    if t = 'ads_factory_cap_settings' then
      if exists (select 1 from pg_policy where polrelid = ('public.' || t)::regclass) then
        raise exception '0131 end state: % has a policy, and it must have none', t;
      end if;
      if has_table_privilege('authenticated', 'public.' || t, 'select') or has_table_privilege('service_role', 'public.' || t, 'select') then
        raise exception '0131 end state: an API role reads %', t;
      end if;
    else
      if (select count(*) from pg_policy where polrelid = ('public.' || t)::regclass) <> 1
         or not exists (select 1 from pg_policy where polrelid = ('public.' || t)::regclass and polname = t || '_select' and polcmd = 'r'
                           and polroles = array[(select oid from pg_roles where rolname = 'authenticated')]) then
        raise exception '0131 end state: % does not have exactly its one SELECT policy for authenticated', t;
      end if;
      if not has_table_privilege('authenticated', 'public.' || t, 'select') or not has_table_privilege('service_role', 'public.' || t, 'select') then
        raise exception '0131 end state: % is not readable by authenticated and service_role', t;
      end if;
    end if;
  end loop;

  if (select count(*) from public.ads_factory_cap_settings) <> 1 then
    raise exception '0131 end state: ads_factory_cap_settings does not hold exactly one row';
  end if;
  if (select count(*) from pg_constraint
       where contype = 'c' and convalidated
         and conname in ('brand_kits_text_check', 'brand_kits_lists_check', 'brand_kits_source_check', 'brand_products_text_check',
                         'brand_products_source_check', 'ad_campaigns_text_check', 'ad_campaigns_choice_check', 'ad_concepts_choice_check',
                         'ad_concepts_text_check', 'ad_concepts_storyboard_check', 'ad_concepts_status_check', 'ad_concepts_batch_check',
                         'ads_factory_cap_settings_one_row', 'ads_factory_cap_settings_numbers')) <> 14 then
    raise exception '0131 end state: a check is missing or not validated';
  end if;
  if (select count(*) from pg_constraint
       where contype = 'f'
         and conname in ('brand_products_kit_fkey', 'brand_product_images_product_fkey', 'ad_campaigns_kit_fkey',
                         'ad_campaign_products_campaign_fkey', 'ad_campaign_products_product_fkey', 'ad_concepts_campaign_fkey')) <> 6 then
    raise exception '0131 end state: a composite foreign key is missing';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal
        and (tgrelid, tgname) in (('public.brand_kits'::regclass, 'brand_kits_asset_guard'),
                                  ('public.brand_product_images'::regclass, 'brand_product_images_asset_guard'),
                                  ('public.ad_concepts'::regclass, 'ad_concepts_guard'),
                                  ('public.ads_factory_cap_settings'::regclass, 'ads_factory_cap_settings_guard'),
                                  ('public.ads_factory_cap_settings'::regclass, 'ads_factory_cap_settings_no_truncate'),
                                  ('public.ads_factory_cap_settings'::regclass, 'ads_factory_cap_settings_trail'))) <> 6 then
    raise exception '0131 end state: a trigger is missing';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor on the live project after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select count(*) = 7 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relrowsecurity
--        and c.relname in ('brand_kits', 'brand_products', 'brand_product_images', 'ad_campaigns', 'ad_campaign_products', 'ad_concepts',
--                          'ads_factory_cap_settings')) as seven_tables_with_rls,
--     not has_table_privilege('authenticated', 'public.brand_kits', 'INSERT')
--       and not has_table_privilege('service_role', 'public.ad_concepts', 'UPDATE')
--       and not has_table_privilege('anon', 'public.brand_kits', 'SELECT') as no_direct_writes_and_nothing_for_anon,
--     has_function_privilege('authenticated', 'public.save_brand_kit(uuid,uuid,text,text,uuid,text[],text[],text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.save_brand_kit(uuid,uuid,text,text,uuid,text[],text[],text)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.add_ad_concepts(uuid,text,jsonb)', 'EXECUTE') as members_only,
--     (select kits_per_org = 5 and products_per_kit = 20 and campaigns_per_org = 20 and concepts_per_campaign = 24
--        from public.ads_factory_cap_settings) as default_numbers_if_untouched,
--     not has_table_privilege('authenticated', 'public.ads_factory_cap_settings', 'SELECT')
--       and not has_table_privilege('service_role', 'public.ads_factory_cap_settings', 'SELECT') as settings_closed_to_api_roles;
--
-- What the tables hold (expected: all zero until the owner switches NIGHTSHIFT_ADS_FACTORY on, unless a member called the functions directly;
-- see the header):
--   select (select count(*) from public.brand_kits) as kits, (select count(*) from public.brand_products) as products,
--          (select count(*) from public.ad_campaigns) as campaigns, (select count(*) from public.ad_concepts) as concepts;
