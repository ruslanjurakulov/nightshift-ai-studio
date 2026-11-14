-- rollback_0171_films_money.sql — takes migration 0171 (Film Studio P2: the film's price, its hold, the worker's settle functions) out
-- again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- READ THIS FIRST. What IS lost: the film_segments rows (which hold paid for which film, what it captured), org_film_settings, the
-- stored quotes, the Film Studio switch (film_studio_settings), and the money columns and provider task ids of film_takes. What is NOT lost: every credit movement, which stays in credit_transactions and credit_reservations
-- (0020's append-only ledger), and every take row (its money columns go; the take itself, its status and its result stay).
-- So the file REFUSES, and changes nothing, while:
--   * any segment is live (queued, running or draining): a hold is open or a worker is spending under it. Cancel it first
--     (select public.film_cancel_segment('<segment id>', 'cancelled'); as the service role or here as the owner) and let it settle;
--   * any creative job has payer 'film' (0036's payer check could not be put back);
--   * a function body of 0171 is not 0171's (a later change would be undone), or a function this file does not know reads
--     film_segments (a later migration is built on it: take that one out first with its own rollback);
--   * any segment exists at all, unless you un-comment the override line under `begin;` (nightshift.rollback_0171_discard_segments),
--     in this same paste, on purpose.
--
-- WHAT IT DOES, in one transaction, holding an ACCESS EXCLUSIVE lock on the two tables it drops from before the checks to the end:
--   1. drops 0171's functions (every body pinned first: a later change would be undone);
--   2. creative_jobs: drops film_take_id (its key, index and check) and puts 0036's payer check back;
--   3. films: puts 0166's status check back (no 'queued');
--   4. film_takes: drops the money columns, their check, key and index;
--   5. drops film_quotes, film_segments, org_film_settings and film_studio_settings;
--   6. asserts the end state.
--
-- tests/security/test_sec_films_money.py applies this file inside a transaction and re-applies 0171 after it; sec_db.take_off_0171 runs
-- it (with the override) where an earlier Film Studio file is replayed or rolled back.

begin;
set local lock_timeout = '5s';
-- set local nightshift.rollback_0171_discard_segments = 'on';
lock table public.film_segments, public.org_film_settings, public.film_quotes, public.film_studio_settings in access exclusive mode;

do $$
declare
  r record;
  h text;
  other text;
begin
  for r in select * from (values
      ('public.film_money_limits()', 'e223954791000348f627dcfc99860772'),
      ('public.film_settings_of(uuid)', '95adf28cbabbc40c16370b52dfbe27c0'),
      ('public.film_studio_on()', '4bc6a03f59a28ea1d7028de23d7f52af'),
      ('public.film_available(uuid)', '526f373f00fe7b8b212fa8a8b97a6946'),
      ('public.film_moderation_billing(text)', '388e9371d104629e56e3255939d2180e'),
      ('public.film_stand_in(uuid)', 'f8452d0d8a7a77be1336c4ca17a0578c'),
      ('public.film_model_problem(text, text[], text)', 'd828ee349aa5da3aa05ea9db4d8f1b94'),
      ('public.film_try_price(uuid, text, text, jsonb)', '6f3ef9a01318ce782acf86fd2fd30e33'),
      ('public.film_precheck(public.films)', 'ff4fa7e8a6386420f32ab6a3a85a778c'),
      ('public.film_price(public.films)', '5de6c9bb2a74079e2078cad2d91b3c34'),
      ('public.film_segment_json(public.film_segments)', 'ebaeb21f07fb833951ccfa0f51af24ae'),
      ('public.film_take_money_json(public.film_takes)', '387f1f2650ad13eb82fec18ff75294bf'),
      ('public.film_lock_segment(uuid, text, boolean)', '053dc28514bf28fbdcdd1de097418f88'),
      ('public.film_lock_take(uuid, text)', '099be6f8255fa8cf59e2c2444d3b1a21'),
      ('public.film_discard_assets(uuid, uuid[])', '4357ecf6a57e5f4ee076680f9e5b3b28'),
      ('public.film_fail_locked(uuid, text, text, text, numeric)', 'd26ed5969d88566460c184eb3555e12c'),
      ('public.film_record_skip(uuid, uuid, uuid, text, text, text)', '8e134baf7858ff4e5d4333ff7f0aadff'),
      ('public.film_lose_inflight_locked(uuid)', 'c08be09f91c672775bc959d34622ce7e'),
      ('public.film_settle_locked(uuid, uuid, text)', 'd8de6618a3092b6a6807788c5cc3eed0'),
      ('public.quote_film(uuid, integer)', '8839e2cb264663acf98c6f49aaaf89a5'),
      ('public.start_film(uuid, text, text)', 'f59f4525e07e1511bc8c3abb31830404'),
      ('public.set_film_studio_enabled(boolean)', '2fa73220535a7351b493061e7fd0a0f4'),
      ('public.film_claim_segment(text, interval)', 'fddd014f8cbcb72603da0b792cc0d31a'),
      ('public.film_heartbeat_segment(uuid, text)', '17b89822d95a918a043229482591163b'),
      ('public.film_begin_take(uuid, text)', 'f112ea9e9f0373b178d120c0cf7b14a0'),
      ('public.film_take_succeeded(uuid, text, numeric, uuid, uuid, text)', 'e12f913eeeb6a4a3a9ab5abe64eeb84f'),
      ('public.film_take_failed(uuid, text, text, text, text, numeric)', '76a5cac7de12839bb949a7992f65ae61'),
      ('public.film_begin_assembly(uuid, text)', '34413a61aa9611f244fc2fa02b497301'),
      ('public.film_record_assembly(uuid, text, boolean, uuid)', '7ea3d7961f09b810b7f42942d41932dd'),
      ('public.film_settle_segment(uuid, text, text)', '68ac358fbd91321b7875a42240b91417'),
      ('public.film_cancel_segment(uuid, text)', '90f06e840094949886f79cd7ab2fce46'),
      ('public.film_expire_segments()', '1c735690fd0bcc61b56e598eb9b0dfad')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0171: % is missing or is not 0171''s body (md5 %): a later change would be undone; read the live body first', r.sig, h;
    end if;
  end loop;
  select string_agg(p.oid::regprocedure::text, ', ') into other
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosrc like '%film_segments%'
     and p.proname not in ('film_money_limits', 'film_settings_of', 'film_studio_on', 'film_available', 'film_moderation_billing', 'film_stand_in', 'film_model_problem', 'film_try_price', 'film_precheck', 'film_price', 'film_segment_json', 'film_take_money_json', 'film_lock_segment', 'film_lock_take', 'film_discard_assets', 'film_fail_locked', 'film_record_skip', 'film_lose_inflight_locked', 'film_settle_locked', 'quote_film', 'start_film', 'set_film_studio_enabled', 'film_claim_segment', 'film_heartbeat_segment', 'film_begin_take', 'film_take_succeeded', 'film_take_failed', 'film_begin_assembly', 'film_record_assembly', 'film_settle_segment', 'film_cancel_segment', 'film_expire_segments');
  if other is not null then
    raise exception 'rollback 0171: a later migration reads film_segments (%): take it out first with its own rollback', other;
  end if;
  if exists (select 1 from public.film_segments where status in ('queued', 'running', 'draining')) then
    raise exception 'rollback 0171: % film segments are live (a hold is open or a worker is spending): cancel them and let them settle first',
      (select count(*) from public.film_segments where status in ('queued', 'running', 'draining'));
  end if;
  if exists (select 1 from public.creative_jobs where payer = 'film') then
    raise exception 'rollback 0171: creative jobs with payer film exist, and 0036''s payer check would refuse them';
  end if;
  if exists (select 1 from public.films where status = 'queued') then
    raise exception 'rollback 0171: a film is queued, and 0166''s status check would refuse it';
  end if;
  if exists (select 1 from public.film_segments)
     and coalesce(current_setting('nightshift.rollback_0171_discard_segments', true), '') <> 'on' then
    raise exception 'rollback 0171: % film segments exist and their record would be deleted (the credit ledger keeps the money); export what must be kept, then set the override line of this file on purpose',
      (select count(*) from public.film_segments);
  end if;
end $$;

-- 1. The functions (the browser's, the service's, then the helpers).
drop function public.quote_film(uuid, integer);
drop function public.start_film(uuid, text, text);
drop function public.set_film_studio_enabled(boolean);
drop function public.film_claim_segment(text, interval);
drop function public.film_heartbeat_segment(uuid, text);
drop function public.film_begin_take(uuid, text);
drop function public.film_take_succeeded(uuid, text, numeric, uuid, uuid, text);
drop function public.film_take_failed(uuid, text, text, text, text, numeric);
drop function public.film_begin_assembly(uuid, text);
drop function public.film_record_assembly(uuid, text, boolean, uuid);
drop function public.film_settle_segment(uuid, text, text);
drop function public.film_cancel_segment(uuid, text);
drop function public.film_expire_segments();
drop function public.film_settle_locked(uuid, uuid, text);
drop function public.film_lose_inflight_locked(uuid);
drop function public.film_record_skip(uuid, uuid, uuid, text, text, text);
drop function public.film_fail_locked(uuid, text, text, text, numeric);
drop function public.film_discard_assets(uuid, uuid[]);
drop function public.film_lock_take(uuid, text);
drop function public.film_lock_segment(uuid, text, boolean);
drop function public.film_take_money_json(public.film_takes);
drop function public.film_segment_json(public.film_segments);
drop function public.film_price(public.films);
drop function public.film_precheck(public.films);
drop function public.film_try_price(uuid, text, text, jsonb);
drop function public.film_model_problem(text, text[], text);
drop function public.film_stand_in(uuid);
drop function public.film_moderation_billing(text);
drop function public.film_available(uuid);
drop function public.film_studio_on();
drop function public.film_settings_of(uuid);
drop function public.film_money_limits();

-- 2. creative_jobs: the film take and 0036's payer check, as 0036 wrote it.
alter table public.creative_jobs drop constraint if exists creative_jobs_film_payer_check;
alter table public.creative_jobs drop constraint if exists creative_jobs_payer_check;
alter table public.creative_jobs add constraint creative_jobs_payer_check
  check (payer in ('credits', 'api_balance'));
drop index if exists public.creative_jobs_film_take_key;
alter table public.creative_jobs drop constraint if exists creative_jobs_film_take_fk;
alter table public.creative_jobs drop column if exists film_take_id;

-- 3. films: 0166's status check, as 0166 wrote it.
alter table public.films drop constraint if exists films_status_check;
alter table public.films add constraint films_status_check
  check (status in ('draft', 'planning', 'planned', 'running', 'draining', 'paused', 'assembling', 'ready',
                    'failed', 'cancelled', 'archived')
         and (pause_reason is null or pause_reason ~ '^[a-z][a-z0-9_]{0,63}$')
         and (pause_detail is null or public.film_text_ok(pause_detail, 1, 500, false))
         and ((status = 'archived') = (archived_at is not null)));

-- 4. film_takes: the money columns (their column grants go with them).
alter table public.film_takes drop constraint if exists film_takes_money_check;
alter table public.film_takes drop constraint if exists film_takes_segment_fk;
drop index if exists public.film_takes_segment_idx;
alter table public.film_takes drop column if exists segment_id;
alter table public.film_takes drop column if exists credit_unit;
alter table public.film_takes drop column if exists unit_credits;
alter table public.film_takes drop column if exists quantity;
alter table public.film_takes drop column if exists minimum_credits;
alter table public.film_takes drop column if exists confirmed_credits;
alter table public.film_takes drop column if exists charged_credits;
alter table public.film_takes drop column if exists charge_basis;
alter table public.film_takes drop column if exists output_seconds;
alter table public.film_takes drop column if exists provider_task_id;

-- 5. The four tables (their policies, indexes and constraints go with them).
drop table public.film_quotes;
drop table public.film_segments;
drop table public.org_film_settings;
drop table public.film_studio_settings;

-- 6. End state.
do $$
begin
  if to_regclass('public.film_segments') is not null or to_regclass('public.org_film_settings') is not null
     or to_regclass('public.film_quotes') is not null or to_regclass('public.film_studio_settings') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                  and ((table_name = 'creative_jobs' and column_name = 'film_take_id')
                       or (table_name = 'film_takes' and column_name in ('segment_id', 'confirmed_credits', 'charged_credits'))))
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                  and proname in ('quote_film', 'start_film', 'film_price', 'film_settle_locked', 'film_claim_segment'))
     or exists (select 1 from pg_constraint where conrelid = 'public.films'::regclass and conname = 'films_status_check'
                  and pg_get_constraintdef(oid) like '%''queued''%')
     or exists (select 1 from pg_constraint where conrelid = 'public.creative_jobs'::regclass
                  and conname = 'creative_jobs_payer_check' and pg_get_constraintdef(oid) like '%''film''%') then
    raise exception 'rollback 0171 end state: something of 0171 is still there';
  end if;
end $$;

commit;
