-- 0222_retire_gemini_omni_1_1.sql — gemini-omni-1.1-flash is retired: model_registry.availability = 'disabled', for good.
--
-- *** LIVE ON APPLY. *** It writes ONE column of ONE row (model_registry.availability for id 'gemini-omni-1.1-flash') and nothing
-- else: no function, policy, grant, trigger, constraint, price or switch.
--
-- EVIDENCE. Google's deprecations page (aistudio.google.com/docs/deprecations, the redirect target of
-- ai.google.dev/gemini-api/docs/deprecations, read 2026-11-22; S10's research, docs/studio/S10_GOOGLE_MODELS.md in PR #917) says the gemini-omni-1.1-flash
-- endpoint "is automatically routing API requests to [gemini-omni-1.2-flash] effective December 3, 2026", billed at 1.2's rates.
--
-- DIAGNOSIS. From that day a call to this id returns another model's output at another model's price. Selling it would be a
-- substitute the vendor makes silently (CLAUDE.md rule 4): the person would be quoted and shown "Omni 1.1" and get 1.2. The
-- registry's `shutdown.on` (2026-12-03) already stops the sale on that day (0125), but it is the vendor's EARLIEST date, and the
-- registry file says it must stay the vendor's date, never ours. The row is also terms-gated today, so nothing sells it now; what
-- this file closes is the future: a later "open" file, an operator preview, or a date moved later after a probe must never put
-- this id back on sale. 'disabled' (0035's lifecycle) is the state every open migration refuses to touch (0173, 0194, 0195:
-- "disabled by the owner: this file does not turn it back on"), sellable_models never lists, creative_price never quotes, and
-- creative_operator_preview refuses (it accepts only 'hidden', 0139). No probe writes availability, and the registry sync
-- (sync_model_registry, 0035) skips a row that is already disabled.
--
-- CHANGE. update model_registry set availability = 'disabled' where id = 'gemini-omni-1.1-flash' (from whatever it is). A missing
-- row (the registry not synced yet) is a NOTICE, not an error: the sync inserts it 'hidden' (still terms-gated, still past nothing
-- until 2026-12-03) and this file, applied again after the sync, disables it. Its replacement, gemini-omni-1.2-flash, is NOT added
-- here: it waits for the owner's terms decisions and a real probe (S10).
--
-- WHO CAN UNDO IT. Not a customer (RLS). Two people can: the owner, with docs/sql/rollback_0222_retire_gemini_omni_1_1.sql
-- (hidden again), and a platform admin, through the model board's availability change (0035 grants update (availability) to a
-- platform admin; command-center/app/api/models/availability, audited as model.availability). Neither can put it on sale while
-- its terms_gate is set (0035's model_registry_terms_before_sale). The reason is kept here and in docs/MIGRATIONS.md, because
-- model_registry has no reason column and 0124's model_availability is the owner's temporary switch, not the sale lifecycle.
--
-- NUMBER: 0222, given by Atlas (stream S10). Idempotent: a replay changes nothing (the WHERE skips a row that is already disabled,
-- so updated_at is not touched). Apply as ONE transaction (SQL editor, apply_migration, or psql --single-transaction
-- -v ON_ERROR_STOP=1).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.model_registry') is null or to_regprocedure('public.sellable_models(text, text)') is null then
    raise exception '0222 needs 0035 (model_registry, sellable_models): apply it first';
  end if;
end $$;

do $$
declare
  mid  constant text := 'gemini-omni-1.1-flash';
  was  text;
  open bigint;
begin
  select availability into was from public.model_registry where id = mid;
  if not found then
    raise notice '0222: % is not in model_registry (not synced yet): nothing to retire; apply this file again after the sync', mid;
    return;
  end if;

  update public.model_registry set availability = 'disabled' where id = mid and availability <> 'disabled';
  raise notice '0222: % retired (was %): Google routes this id to gemini-omni-1.2-flash from 2026-12-03', mid, was;

  -- A job not yet finished on it would run on whatever Google serves on the day; name them, so the owner can refund or cancel them
  -- (none can exist while the row is terms-gated and not an operator preview).
  if to_regclass('public.creative_jobs') is not null then
    execute 'select count(*) from public.creative_jobs where (requested_model = $1 or routed_model = $1) and status not in (''completed'', ''failed'', ''cancelled'', ''expired'')' into open using mid;
    if open > 0 then
      raise notice '0222: % job(s) on % are not finished (queued, planning, running, provider_pending, processing or rendering): review them before 2026-12-03', open, mid;
    end if;
  end if;

  -- End state, read back.
  if (select availability from public.model_registry where id = mid) is distinct from 'disabled' then
    raise exception '0222 end state: % is not disabled', mid;
  end if;
  if exists (select 1 from public.sellable_models(null, 'web') s where s.id = mid)
     or exists (select 1 from public.sellable_models(null, 'api') s where s.id = mid)
     or exists (select 1 from public.sellable_models(null, 'mcp') s where s.id = mid) then
    raise exception '0222 end state: % is still offered', mid;
  end if;
end $$;

-- Verify (read-only, after applying):
--   select id, availability from public.model_registry where id = 'gemini-omni-1.1-flash';
--   select count(*) from public.sellable_models(null, 'web') where id = 'gemini-omni-1.1-flash';   -- 0
