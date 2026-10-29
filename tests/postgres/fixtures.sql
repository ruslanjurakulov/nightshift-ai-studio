-- Local-only synthetic fixtures. No production identifiers or credentials.
begin;

do $$
begin
  if to_regclass('public.organizations') is null
     or to_regclass('public.creative_jobs') is null then
    raise exception 'required migrations were not loaded';
  end if;
end $$;

-- This file intentionally does not invent rows for schemas whose organization
-- membership and credit constraints vary across migration versions. The SQL
-- runner creates fixtures through the repository's public functions after the
-- complete chain has loaded.
commit;

