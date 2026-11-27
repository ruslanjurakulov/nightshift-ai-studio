-- 0225_creative_jobs_member_columns.sql — a member no longer reads a worker's id or a vendor's task id off a creative job, and the
-- worker ids already stored in two event trails are replaced by the reference 0215 writes. Provisional number.
--
-- WHY. 0036 granted SELECT on the whole of public.creative_jobs to `authenticated` (RLS: the org's viewers). Two of its columns are
-- the platform's, not the workspace's:
--   * worker_id         the film worker's and the credit worker's id, the host name and the process id by default
--                       (tools/*_worker.py). Ledger BR-0036-01 (low).
--   * provider_task_id  the vendor's task id, which 0171 already withholds from members on film_takes; the same take's job handed
--                       it out again. Ledger BR-S-031 (low).
-- A column REVOKE under a table-level grant changes nothing (has_column_privilege stays true), so this file does what 0166 and 0171
-- do: revoke the table grant, then grant the named columns.
-- And the rows written before 0215 still carry the worker id as detail.worker in creative_job_events (0036/0198
-- claim_creative_job) and film_events (0171/0198 film_claim_segment), both member-readable. Ledger BR-0036-02 (low).
--
-- WHAT CHANGES.
--   1. creative_jobs: `authenticated` loses the table-level SELECT and gets SELECT on every column except worker_id and
--      provider_task_id (the list below, written out from information_schema when this file was written). `anon` holds nothing
--      and is revoked again. service_role and the security-definer functions are untouched.
--      A guard stops the file when the table has a column the list does not name, or the list names one the table lacks: a
--      column added later is decided on deliberately, never exposed or hidden by accident.
--   2. BR-0036-02: a one-time, idempotent redaction of detail.worker in film_events and creative_job_events, as 0088:66-77 did
--      for creative_job_events: the append-only trigger is disabled, the rows are updated, the trigger is enabled again, all in
--      this one transaction. Each object detail that has a `worker` key becomes
--        (detail - 'worker') || {"worker_ref": left(md5(detail->>'worker'), 12)}
--      which is exactly the reference 0215 writes on a new row, so an old and a new claim by one worker still read as one worker.
--      Nothing else in any row changes; the file counts and checksums the rows before and after and stops if anything differs.
--   3. An end-state check: no table-level SELECT for authenticated or anon; worker_id and provider_task_id not selectable by
--      them; every listed column selectable by authenticated; both append-only triggers enabled.
--
-- WHAT IT DOES NOT DO. No function, policy, view or table changes; no money, publishing or privacy path is touched. The redaction
-- is not undone by the rollback (the worker ids are gone by design); the rollback restores only the table grant.
--
-- READERS CHECKED (every reader of creative_jobs columns, against this file's list; none reads worker_id or provider_task_id):
--   Command Center (anon key + the member's session, RLS):
--     lib/server/creative.ts readJob / listJobs   select JOB_COLUMNS (lib/creative/operations.ts: id, org_id, kind, capability,
--                                                 mode, requested_model, routed_model, fallback_from, fallback_reason, params,
--                                                 status, payer, quoted_credits, charged_credits, error_code, error, result,
--                                                 result_asset_ids, expires_at, created_at, updated_at, started_at, finished_at);
--                                                 filters id, org_id, payer, capability, created_at
--     lib/server/creative.ts jobDurations         select started_at, finished_at; filters org_id, status, payer, routed_model,
--                                                 requested_model, finished_at
--     lib/server/workflows.ts                     select id, status, result_asset_ids; filter id
--     No other app read: no select('*') and no embedded creative_jobs(...) resource; the Brain, the live view, agents, the
--     public API and the MCP routes reach jobs through security-definer functions only (brain_org_facts, api_creative_get,
--     api_creative_job_files, oauth_creative_get, workflow_run_json ...). No server route reads the table with the service key.
--   Views: public.creative_economics (0037, security_invoker; platform admins only by its WHERE) reads id, routed_model,
--     finished_at, status, charged_credits. It is the only view over the table.
--   RLS policies that read the table as the caller: caption_tracks_select (0072) reads id, org_id, status.
--   Security-definer functions (run as their owner, unaffected): advance_creative_job, api_creative_create, api_creative_get,
--     api_creative_job_files, api_creative_month_credits, approve_voice, attach_creative_job_assets, brain_org_facts,
--     cancel_creative_job, claim_creative_job, create_creative_job, creative_end_locked, creative_expire_locked,
--     creative_job_source, creative_job_style, creative_jobs_route_recorded, film_claim_segment, film_discard_assets,
--     film_discard_unrecorded_assembly, film_settle_locked, film_take_job, finish_creative_job, heartbeat_creative_job,
--     model_switch_counts, model_switch_note_quota, model_switch_stop_jobs, oauth_creative_create, oauth_creative_get,
--     oauth_grant_month_credits, operator_customer_accounts, operator_margin_report, owner_analytics_activity,
--     owner_analytics_jobs, owner_analytics_model_activity, owner_analytics_people, owner_brain_health,
--     public_site_stats_measure, record_creative_job_cost, reroute_creative_job, store_caption_track,
--     workflow_advance_locked, workflow_run_json. The one security-invoker function that reads the table,
--     creative_region_outcomes, is not executable by authenticated.
--   Python: modules/creative_worker.py, modules/operator_bot/sources.py and tools/export_showcase.py read with the service key
--     (service_role keeps its table-level SELECT); no Python code uses an authenticated client.
--   Realtime: creative_jobs, creative_job_events and film_events are in no publication.
--
-- Requires 0036 (creative_jobs, creative_job_events), 0166/0171 (film_events). Meant to follow 0215, which stops new rows from
-- carrying a worker id; applied before it, the file still works and says so (NOTICE), and running it again later redacts what
-- the old functions wrote in between.
-- Undo: docs/sql/rollback_0225_creative_jobs_member_columns.sql (owner-applied).
-- APPLY AS ONE TRANSACTION.
--
-- WHAT TO VERIFY BEFORE YOU APPLY:
--   select count(*) from public.creative_job_events where jsonb_typeof(detail) = 'object' and detail ? 'worker';
--   select count(*) from public.film_events where jsonb_typeof(detail) = 'object' and detail ? 'worker';
-- (the rows the redaction rewrites; it takes a lock on both trails for the length of the update).
-- LIVE ON APPLY: the Command Center keeps reading every column it reads today; a direct select of worker_id, provider_task_id,
-- `*` or a whole row by a member answers 42501.

set local lock_timeout = '5s';

-- ── Guard: the column list is the table's, exactly ──────────────────────────

do $$
declare
  listed   text[] := array['id', 'org_id', 'kind', 'capability', 'mode', 'requested_model', 'routed_model', 'route',
                           'fallback_from', 'fallback_reason', 'params', 'status', 'submit_started_at', 'attempts',
                           'max_attempts', 'heartbeat_at', 'started_at', 'finished_at', 'expires_at', 'payer', 'credit_ref',
                           'credit_unit', 'quantity', 'quoted_credits', 'charged_credits', 'error_code', 'error', 'result',
                           'result_asset_ids', 'parent_job_id', 'idempotency_key', 'request_hash', 'requested_by', 'created_at',
                           'updated_at', 'routed_credits', 'routing', 'film_take_id'];
  withheld text[] := array['worker_id', 'provider_task_id'];
  extra    text[];
  missing  text[];
begin
  if to_regclass('public.creative_jobs') is null or to_regclass('public.creative_job_events') is null then
    raise exception '0225 needs public.creative_jobs and public.creative_job_events: apply 0036 first';
  end if;
  if to_regclass('public.film_events') is null then
    raise exception '0225 needs public.film_events: apply 0166 first';
  end if;
  select array_agg(column_name::text order by ordinal_position) into extra
    from information_schema.columns
   where table_schema = 'public' and table_name = 'creative_jobs'
     and column_name::text <> all (listed || withheld);
  if extra is not null then
    raise exception '0225: creative_jobs has columns this file does not list (%): decide for each whether members may read it, '
                    'then add it to the grant or to the withheld list', extra;
  end if;
  select array_agg(c) into missing
    from unnest(listed || withheld) c
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'creative_jobs' and column_name = c);
  if missing is not null then
    raise exception '0225: creative_jobs lacks columns this file lists (%): read the live table first', missing;
  end if;
  if position('worker_ref' in coalesce((select prosrc from pg_proc
                                          where oid = to_regprocedure('public.claim_creative_job(text, interval)')), '')) = 0 then
    raise notice '0225: claim_creative_job still writes detail.worker (0215 not applied): run this file again after 0215';
  end if;
end $$;

-- ── 1. creative_jobs: named columns, never worker_id or provider_task_id ────

revoke select on public.creative_jobs from authenticated;
revoke all on public.creative_jobs from anon;
grant select (id, org_id, kind, capability, mode, requested_model, routed_model, route, fallback_from, fallback_reason, params,
              status, submit_started_at, attempts, max_attempts, heartbeat_at, started_at, finished_at, expires_at, payer,
              credit_ref, credit_unit, quantity, quoted_credits, charged_credits, error_code, error, result, result_asset_ids,
              parent_job_id, idempotency_key, request_hash, requested_by, created_at, updated_at, routed_credits, routing,
              film_take_id)
  on public.creative_jobs to authenticated;

-- ── 2. BR-0036-02: the worker ids stored before 0215 ────────────────────────

do $$
declare
  t          record;
  ids        bigint[];
  n_all      bigint;
  n_after    bigint;
  n_done     bigint;
  n_left     bigint;
  sum_before text;
  sum_after  text;
  -- Every column of the rewritten rows, with detail minus the two keys this file may touch: what must read the same after.
  rest       constant text := 'select md5(coalesce(string_agg(((to_jsonb(e) - ''detail'') '
                              '|| jsonb_build_object(''detail'', e.detail - ''worker'' - ''worker_ref''))::text, '','' '
                              'order by e.id), '''')) from public.%I e where e.id = any ($1)';
begin
  for t in select * from (values ('film_events', 'film_events_append_only'),
                                 ('creative_job_events', 'creative_job_events_append_only')) v(tbl, trg) loop
    -- Held until commit: a worker still on a pre-0215 body cannot add a row between the count and the update.
    execute format('lock table public.%I in share row exclusive mode', t.tbl);
    execute format('select count(*) from public.%I', t.tbl) into n_all;
    execute format('select coalesce(array_agg(id order by id), ''{}'') from public.%I '
                   'where jsonb_typeof(detail) = ''object'' and detail ? ''worker''', t.tbl) into ids;
    if cardinality(ids) = 0 then
      continue;  -- a replay finds nothing to do and leaves the trigger alone
    end if;
    execute format(rest, t.tbl) into sum_before using ids;

    execute format('alter table public.%I disable trigger %I', t.tbl, t.trg);
    execute format('update public.%I set detail = (detail - ''worker'') '
                   '|| jsonb_build_object(''worker_ref'', left(md5(detail ->> ''worker''), 12)) '
                   'where id = any ($1)', t.tbl) using ids;
    get diagnostics n_done = row_count;
    execute format('alter table public.%I enable trigger %I', t.tbl, t.trg);

    execute format(rest, t.tbl) into sum_after using ids;
    execute format('select count(*), count(*) filter (where jsonb_typeof(detail) = ''object'' and detail ? ''worker'') '
                   'from public.%I', t.tbl) into n_after, n_left;
    if n_done <> cardinality(ids) or n_after <> n_all or n_left <> 0 then
      raise exception '0225: % rewrote % of % rows; % rows after (was %), % still carrying a worker id',
                      t.tbl, n_done, cardinality(ids), n_after, n_all, n_left;
    end if;
    if sum_after is distinct from sum_before then
      raise exception '0225: the redaction of % changed more than detail.worker', t.tbl;
    end if;
    raise notice '0225: % rows of % now carry worker_ref instead of a worker id', n_done, t.tbl;
  end loop;
end $$;

-- ── 3. End state ────────────────────────────────────────────────────────────

do $$
declare
  c text;
begin
  if has_table_privilege('authenticated', 'public.creative_jobs', 'SELECT')
     or has_table_privilege('anon', 'public.creative_jobs', 'SELECT') then
    raise exception '0225: a table-level SELECT on creative_jobs is still held by authenticated or anon';
  end if;
  if exists (select 1 from pg_class cl, aclexplode(cl.relacl) a
              where cl.oid = 'public.creative_jobs'::regclass and a.grantee = 0) then
    raise exception '0225: PUBLIC holds a privilege on creative_jobs';
  end if;
  foreach c in array array['worker_id', 'provider_task_id'] loop
    if has_column_privilege('authenticated', 'public.creative_jobs', c, 'SELECT')
       or has_column_privilege('anon', 'public.creative_jobs', c, 'SELECT') then
      raise exception '0225: creative_jobs.% is still selectable by a member', c;
    end if;
  end loop;
  for c in select column_name::text from information_schema.columns
            where table_schema = 'public' and table_name = 'creative_jobs'
              and column_name::text not in ('worker_id', 'provider_task_id') loop
    if not has_column_privilege('authenticated', 'public.creative_jobs', c, 'SELECT') then
      raise exception '0225: creative_jobs.% is no longer selectable by a member', c;
    end if;
    if has_column_privilege('anon', 'public.creative_jobs', c, 'SELECT') then
      raise exception '0225: creative_jobs.% is selectable by anon', c;
    end if;
  end loop;
  if exists (select 1 from (values ('public.film_events', 'film_events_append_only'),
                                   ('public.creative_job_events', 'creative_job_events_append_only')) v(tbl, trg)
              where not exists (select 1 from pg_trigger g
                                 where g.tgrelid = v.tbl::regclass and g.tgname = v.trg and g.tgenabled = 'O')) then
    raise exception '0225: an append-only trigger of film_events / creative_job_events is not enabled';
  end if;
end $$;

-- Verify (run after applying; each should answer as noted):
--   select has_table_privilege('authenticated', 'public.creative_jobs', 'SELECT');                           -- false
--   select has_column_privilege('authenticated', 'public.creative_jobs', 'worker_id', 'SELECT'),
--          has_column_privilege('authenticated', 'public.creative_jobs', 'provider_task_id', 'SELECT');     -- false, false
--   select count(*) from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'creative_jobs' and grantee = 'authenticated'
--      and privilege_type = 'SELECT';                                                                         -- 38
--   select count(*) from public.creative_job_events where jsonb_typeof(detail) = 'object' and detail ? 'worker'; -- 0
--   select count(*) from public.film_events where jsonb_typeof(detail) = 'object' and detail ? 'worker';         -- 0
--   select tgname, tgenabled from pg_trigger
--    where tgname in ('film_events_append_only', 'creative_job_events_append_only');                          -- both 'O'
