-- 0187_public_models_on_sale.sql — the names of the models a person can buy in the Studio today, for the public landing page.
--
-- EVIDENCE:
--   * The landing's model strip (S4 sprint brief) must show "only the models currently on sale", read the way /pricing reads them.
--     /pricing reads public.sellable_models(), and only for a signed-in member: every migration since 0035 revokes it from anon
--     (it returns the charged rate and the public half of spec). A signed-out visitor — everyone on "/" — gets 42501.
--   * The landing's other model mentions are built from lib/site/showcase.json, whose 45 entries are all operator previews
--     (made before their model was on sale). They say which model made a sample; they cannot say what is for sale now.
--
-- DIAGNOSIS: there is no public read of "on sale". Copying sellable_models' conditions into a second function would let the two
--   drift (0124 and 0125 each added a condition); granting sellable_models to anon would publish rates and spec.
--
-- CHANGE (additive; no table, policy or existing function is touched):
--   public_models_on_sale()  security definer, stable. Returns one row per model that sellable_models(null, 'web') lists — the very
--     same function, so the two cannot disagree — with ONLY: the registry's display_name and its capability codes, ordered by
--     display name. No id, provider, price, credit unit, margin, spec or availability tier. Executable by anon and authenticated.
--
-- WHAT A READER SEES: e.g. ("Ideogram 3", {t2i,edit}), ("MiniMax H3", {t2v,i2v}). The app maps capability codes to its own words
--   (image, video, voice); an empty answer means "nothing on sale" and the strip is not drawn. If this file is not applied the
--   function is missing, the read fails, and the landing draws no strip (it never falls back to a guessed list).
--
-- WHAT ELSE BECOMES PUBLIC (decided, not accidental):
--   * A model sold only on some plans (model_registry.entitlement set) is listed like any other: it IS on sale. The landing calls the
--     list "Models in the Studio today", and /pricing says which plan includes what.
--   * When the owner switches a model off (0124) or its shutdown day comes (0125), it leaves this list as it leaves sellable_models:
--     a visitor who compares the list over time can see that it changed. Nothing about why is exposed.
--   * A model with no capability codes would not be listed (none is sold that way; it could not be used).
--
-- VERIFY (after apply):
--   select * from public.public_models_on_sale();                                   -- names + capabilities only
--   select (select count(*) from public.public_models_on_sale())
--        = (select count(distinct display_name) from public.sellable_models(null, 'web'));   -- true
--   set role anon; select count(*) from public.public_models_on_sale(); reset role;  -- works signed out
--   set role anon; select * from public.sellable_models(null, 'web'); reset role;    -- still 42501

-- A public read must never queue behind a long lock on apply.
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.sellable_models(text, text)') is null then
    raise exception '0187 needs 0035 (model_registry, sellable_models): apply it first';
  end if;
end
$$;

create or replace function public.public_models_on_sale()
  returns table (display_name text, capabilities text[])
  language sql stable security definer set search_path = public, pg_temp as $$
  -- Two registry rows can share a display name (one model sold under two ids); a visitor sees the name once, with every
  -- capability either row is sold for.
  select x.display_name, array_agg(distinct cap order by cap)
    from public.sellable_models(null, 'web') x
    cross join lateral unnest(x.capabilities) as cap
   group by x.display_name
   order by x.display_name;
$$;

comment on function public.public_models_on_sale() is
  'The display names (and capability codes) of the models sellable_models(null, ''web'') lists today. No price, id, provider or spec. Public: the landing page reads it signed out (0187).';

revoke all on function public.public_models_on_sale() from public;
grant execute on function public.public_models_on_sale() to anon, authenticated;
