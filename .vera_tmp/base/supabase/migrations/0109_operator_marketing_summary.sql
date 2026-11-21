-- 0109_operator_marketing_summary.sql — ONE read-only function, so the operator bot can TELL the owner what the
-- brand-channel poster is doing. NOTHING CALLS IT UNTIL THE BOT'S /marketing AND MARKETING ALERTS (this PR) RUN.
-- Design: docs/MARKETING_POSTS.md (slice 7) and docs/operator-bot.md ("Marketing").
--
-- *** APPLYING THIS FILE CHANGES THE LIVE DATABASE. Merging it to main applies it
-- *** automatically, and an applied migration is never edited: fix by a new forward
-- *** migration (docs/MIGRATIONS.md).
--
-- WHY A FUNCTION. 0108 took every table privilege on marketing_posts and marketing_settings away from
-- service_role (the SQL editor, the owner functions and the poster's three functions are the only ways in). The
-- operator bot reads with the service key, so it cannot select from them, and it must not be given a table grant:
-- a grant would let anything holding the service key read every post's words. This function returns numbers,
-- kinds and closed codes, and nothing else, so the bot can say "2 posts are waiting for your approval" without
-- ever being able to see, or change, what a post says.
--
-- WHAT IT RETURNS (one jsonb object):
--   ok            true
--   counts        {draft, approved, sending, sent, failed, dead, rejected, expired}: how many posts are in each
--                 status (all eight keys, a status with no post reads 0: the table was read, so zero is a measurement)
--   used_7d       marketing_cap_used(): the posts that took a weekly slot (sending, sent, dead), the number the cap uses
--   max_per_7d    the cap (marketing_settings.max_per_7d)
--   enabled       the poster's database switch (marketing_settings.enabled)
--   last_sent_at  when the newest sent post went out, UTC ISO 8601, or null
--   last_sent_kind  its kind: news | showcase | price, or null
--   last_failure  null, or {status: failed | dead, last_error_code, kind, at}: the newest post that ended failed or dead
--                 (last_error_code is the closed list of 0108, or null)
-- NEVER returned: a post's texts, link, media path, facts, hash, idempotency key, source, provider message id, id,
-- an approver or a chat. A test (tests/security/test_sec_marketing_summary.py) searches the answer for the words of
-- every post it creates.
--
-- WHO MAY CALL IT. service_role ONLY (revoke all from public, anon, authenticated, service_role, then one grant).
-- A signed-in owner already has owner_marketing_get() and the posts themselves (0108); this is not for the browser.
--
-- DORMANT / ADDITIVE.
--   * One new function. NO existing table, policy, grant, trigger or function is changed or redefined; in
--     particular audit_action_allowed(text) is untouched (the function only reads, so it writes no audit row).
--   * Read only: it takes no lock beyond the reads, writes nothing, and cannot change a post's state.
--   * Applying it before or after the bot code is safe: without it the bot says "not available yet".
--
-- Additive and idempotent: create or replace for the new function, revoke then grant (a replay leaves the same ACL).
-- REQUIRES 0108 (marketing_posts, marketing_settings, marketing_cap_used).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.marketing_posts') is null or to_regclass('public.marketing_settings') is null
     or to_regprocedure('public.marketing_cap_used()') is null then
    raise exception '0109 needs 0108_marketing_posts.sql (marketing_posts, marketing_settings, marketing_cap_used): apply it first';
  end if;
end $$;

create or replace function public.operator_marketing_summary() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_max     integer;
  v_enabled boolean;
  v_counts  jsonb;
  v_sent    record;
  v_fail    record;
begin
  select s.max_per_7d, s.enabled into v_max, v_enabled from public.marketing_settings s limit 1;

  select jsonb_object_agg(k.status, coalesce(c.n, 0)) into v_counts
    from unnest(array['draft', 'approved', 'sending', 'sent', 'failed', 'dead', 'rejected', 'expired']) as k(status)
    left join (select p.status, count(*)::integer as n from public.marketing_posts p group by p.status) c
      on c.status = k.status;

  select p.kind, p.sent_at into v_sent from public.marketing_posts p
   where p.status = 'sent' and p.sent_at is not null
   order by p.sent_at desc, p.id limit 1;

  -- failed and dead are final (the guard trigger refuses any later change), so updated_at is when the post ended.
  select p.status, p.last_error_code, p.kind, p.updated_at into v_fail from public.marketing_posts p
   where p.status in ('failed', 'dead')
   order by p.updated_at desc, p.id limit 1;

  return jsonb_build_object(
    'ok', true,
    'counts', v_counts,
    'used_7d', public.marketing_cap_used(),
    'max_per_7d', v_max,
    'enabled', v_enabled,
    'last_sent_at', to_char(v_sent.sent_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'last_sent_kind', v_sent.kind,
    'last_failure', case when v_fail.status is null then null else jsonb_build_object(
      'status', v_fail.status,
      'last_error_code', v_fail.last_error_code,
      'kind', v_fail.kind,
      'at', to_char(v_fail.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) end);
end
$$;

comment on function public.operator_marketing_summary() is
  'Counts by status, the week''s use of the cap, the switch, the last sent post and the last failure of the brand-channel poster (migration 0109). Numbers, kinds and closed codes only: never a text, link, media or chat. service_role only: the operator bot reads it.';

revoke all on function public.operator_marketing_summary() from public, anon, authenticated, service_role;
grant execute on function public.operator_marketing_summary() to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     has_function_privilege('service_role', 'public.operator_marketing_summary()', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.operator_marketing_summary()', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.operator_marketing_summary()', 'EXECUTE') as callable_by_service_only,
--     (select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
--        from pg_proc p where p.oid = 'public.operator_marketing_summary()'::regprocedure) as definer_pins_search_path,
--     not has_table_privilege('service_role', 'public.marketing_posts', 'SELECT') as tables_still_closed,
--     (public.operator_marketing_summary() ->> 'ok')::boolean as answers,
--     (select count(*) = 8 from jsonb_object_keys(public.operator_marketing_summary() -> 'counts')) as eight_statuses;
--
-- ROLLBACK (owner-applied, docs/sql/rollback_0109_operator_marketing_summary.sql): drops the function. The bot then
-- says "not available yet".
