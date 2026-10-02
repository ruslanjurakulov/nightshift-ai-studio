-- 0065_style_library.sql — the Style Library (built-in art directions) lands
-- in an organization as an ordinary style kit.
--
-- WHY SQL AT ALL
--   The library is code (command-center/lib/styles/library.ts), so adding one
--   should only have to copy a name and a description into a style kit — which
--   is exactly what a generation already reads (0048 creative_job_style ->
--   modules/creative_style.py "Look: ..."). But save_style_kit() (0047) demands
--   3-12 reference IMAGES from the organization's library, and a built-in
--   direction has none. There was no way to create it through the existing
--   path; this migration adds the one narrow door that can.
--
-- WHAT IT ADDS
--   style_kits.library_id       text, null for every kit made from pictures.
--                               The library style a kit was added from
--                               ('^[a-z0-9]+(-[a-z0-9]+)*$', 2-48 chars).
--                               One kit per (organization, library style):
--                               adding the same style twice is one kit.
--   add_library_style_kit(org, library_id, name, description) -> jsonb
--                               {id, created}. Creates the kit WITHOUT
--                               references, or returns the one that already
--                               exists (created = false) and changes nothing
--                               on it — a person's edits to their copy are
--                               never overwritten by a second click.
--
-- WHAT STAYS THE SAME
--   * RLS and grants on style_kits are untouched (members read, editors
--     delete, nobody inserts or updates directly). library_id is readable like
--     the rest of the row and writable by no API role: add_library_style_kit
--     is the only way to set it, and save_style_kit never touches it.
--   * A kit made from pictures still needs 3-12 references (save_style_kit,
--     the deferred count trigger). A library kit starts with none, because the
--     direction is the description; it may be edited later with save_style_kit
--     like any kit, which then asks for its 3-12 images.
--   * Same checks as save_style_kit: signed in, editor of the organization,
--     name 1-60 characters, description <= 2000, at most 50 kits per
--     organization (one writer at a time, so the cap holds under parallel
--     requests). The name and description are taken as given — the
--     organization's own kit, which an editor could write by hand anyway; the
--     library's text is not a trust boundary.
--
-- ERRORS (SQLSTATE; the message is the machine code the app maps)
--   42501 forbidden (not signed in / not an editor of the organization)
--   NS400 invalid_library_id | invalid_name | invalid_description
--   NS429 limit_reached (the organization already has 50 kits)
--
-- REQUIRES 0047. Additive and idempotent: a guarded column, a guarded
-- constraint, a guarded index, create-or-replace of a NEW function.

do $$
begin
  if to_regclass('public.style_kits') is null
     or to_regprocedure('public.style_clean_text(text, boolean)') is null then
    raise exception '0065 needs style kits: apply 0047_style_kits_characters.sql first';
  end if;
end $$;

alter table public.style_kits add column if not exists library_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'style_kits_library_id_check') then
    alter table public.style_kits
      add constraint style_kits_library_id_check
      check (library_id is null
             or (char_length(library_id) between 2 and 48 and library_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'));
  end if;
end $$;

-- At most one kit per library style per organization; also what makes two
-- parallel "add" presses land on one kit.
create unique index if not exists style_kits_org_library_key
  on public.style_kits (org_id, library_id) where library_id is not null;

comment on column public.style_kits.library_id is
  'Migration 0065: the built-in library style this kit was added from (null for a kit made from pictures). A library kit may hold no reference images until someone adds them.';

create or replace function public.add_library_style_kit(
  p_org uuid, p_library_id text, p_name text, p_description text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lib_  text := coalesce(p_library_id, '');
  name_ text := public.style_clean_text(p_name, false);
  desc_ text := public.style_clean_text(p_description, true);
  k     public.style_kits;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_org is null or not public.is_org_member(p_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if char_length(lib_) not between 2 and 48 or lib_ !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'invalid_library_id' using errcode = 'NS400', detail = 'pattern=^[a-z0-9]+(-[a-z0-9]+)*$';
  end if;
  if char_length(name_) not between 1 and 60 then
    raise exception 'invalid_name' using errcode = 'NS400', detail = 'max=60';
  end if;
  if char_length(desc_) not between 1 and 2000 then
    raise exception 'invalid_description' using errcode = 'NS400', detail = 'max=2000';
  end if;

  -- One writer per organization at a time, the same lock save_style_kit takes.
  perform pg_advisory_xact_lock(hashtextextended('style_kits:' || p_org::text, 0));

  select * into k from public.style_kits where org_id = p_org and library_id = lib_;
  if found then
    return jsonb_build_object('id', k.id, 'created', false);
  end if;

  if (select count(*) from public.style_kits where org_id = p_org) >= 50 then
    raise exception 'limit_reached' using errcode = 'NS429', detail = 'max=50';
  end if;

  insert into public.style_kits (org_id, name, description, created_by, library_id)
  values (p_org, name_, desc_, auth.uid(), lib_)
  returning * into k;
  return jsonb_build_object('id', k.id, 'created', true);
end
$$;

revoke all on function public.add_library_style_kit(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.add_library_style_kit(uuid, text, text, text) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   exists (select 1 from information_schema.columns
--            where table_schema = 'public' and table_name = 'style_kits'
--              and column_name = 'library_id') as column_added,
--   exists (select 1 from pg_indexes
--            where schemaname = 'public' and indexname = 'style_kits_org_library_key') as one_per_org,
--   (select relrowsecurity from pg_class where oid = 'public.style_kits'::regclass) as rls_on,
--   not has_table_privilege('authenticated', 'public.style_kits', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.style_kits', 'UPDATE')
--     and not has_table_privilege('anon', 'public.style_kits', 'SELECT') as table_still_scoped,
--   has_function_privilege('authenticated', 'public.add_library_style_kit(uuid,text,text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.add_library_style_kit(uuid,text,text,text)', 'EXECUTE')
--     and not has_function_privilege('service_role', 'public.add_library_style_kit(uuid,text,text,text)', 'EXECUTE')
--     as function_scoped;
