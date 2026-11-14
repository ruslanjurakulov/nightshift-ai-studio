-- 0171_films_money.sql — Film Studio P2: the price of a whole film, one credit hold that pays for it, and the service calls that settle it.
--
-- WHAT IT ADDS (docs/FILM_STUDIO.md, "Money (P2)", has the plan in prose)
--   org_film_settings    per organization: a per-film credit cap (none by default) and how many films may run at once (1 by default).
--   film_segments        one funding hold of a film: the confirmed total, the credit hold that pays for it (`fm-<id>`), the assembly
--                        line, and the lease a worker holds while it runs the film. Written only by the functions below.
--   film_takes           + the money of each take: which segment pays for it, the confirmed line (unit, rate as charged, quantity,
--                        minimum, credits), what was charged and on what basis, and the measured output seconds.
--   creative_jobs        + film_take_id, and payer may be 'film' (only with a take and never with a hold of its own).
--   films.status         + 'queued' (a film whose hold is taken and that waits for a worker).
--   quote_film(film, version)                   editors and above: the price of the whole film, line by line, from the backend's rates.
--   start_film(film, quote_id, idempotency_key) admins and above: re-prices, holds the total, creates the segment and its planned takes.
--   film_claim_segment, film_heartbeat_segment, film_begin_take, film_take_succeeded, film_take_failed, film_begin_assembly,
--   film_record_assembly, film_settle_segment, film_cancel_segment, film_expire_segments
--                                               the service role only: the state machine P3's worker drives.
--
-- THE MONEY (docs/research film-architecture §3; the evidence is 0034 and 0020)
--   * ONE HOLD PER SEGMENT, NOT PER SCENE OR TAKE. 0034's credit_reservations_concurrency counts every OPEN hold as one parallel run
--     (default 1 a plan), so a hold per scene would run a 40-scene film one scene at a time and lock the organization out of the Studio
--     for the whole film. capture_credits settles once (0020), and the segment is the unit that settles. One hold also checks the whole
--     price before the first paid call, so a film never runs out of credits half way. A segment's hold is reserve_credits(org,
--     'fm-<segment id without dashes>', total), called by start_film in the admin's own session: 0020's public API, unchanged. No credit
--     function body is replaced by this file.
--   * THE PRICE IS THE STUDIO'S. Every key frame and every clip shot is priced by creative_price (0159), the function behind
--     /api/creative/quote, so a take costs exactly what the same generation costs in the Studio (job_minimum included, per line). A clip
--     is i2v from a picture that does not exist yet (the key frame): its price does not depend on which picture, so it is priced against
--     a stand-in, a usable picture of the organization's library, as 0073 prices a chained workflow step. No picture in the library: the
--     clip is unpriced (source_unavailable), never 0. A shot's length is the scene's planned seconds over its shots, rounded UP to a
--     length the model lists (spec.durations_s); a scene longer than the model's longest shot times its shots is refused by name.
--     The narration is one film-level take: creative_price gives the voice model's rate as charged and its minimum, and the line is that
--     rate times every character of narration (one call cannot carry more than 4,000 characters, and a film has up to 120,000).
--     The assembly is `film_assembly_minute` (credit_prices) times the planned minutes, rounded up. THIS FILE SEEDS NO PRICE: a row
--     with no number is impossible (credits_per_unit is NOT NULL) and a number would be a guess. Until a platform admin sets the row,
--     every film is unpriced (`unpriced`, named on the assembly line) and cannot start.
--   * UNKNOWN IS NEVER 0 (CLAUDE.md #5). Any line that cannot be priced makes the total NULL and the quote_id NULL, and the line says
--     why in the database's own word (unpriced, model_not_available, model_not_offered, source_unavailable, scene_too_long_for_model,
--     refs_not_supported, voice_not_set, channel_voice_not_priced, ...). Captions are NOT in the price and the quote says so
--     (`excluded`): a captions job is priced by the measured seconds of a recording that does not exist yet, and nothing in this file
--     lets a worker spend on captions under a film's hold. A retry allowance is not added: there is no line a retry could be charged to.
--   * PINNED. quote_id = 'fq-<film version>-<md5 of the priced lines and the total>'. save_film bumps the version, so any edit makes
--     every earlier quote stale (film_changed); a rate, a model's sale or a price row that changed makes start_film's own re-pricing
--     differ (price_changed). What was confirmed is what is held, in either direction.
--   * CAPTURE <= HOLD, PER TAKE AND IN TOTAL. A take's charge is set once, when its result is recorded, never above its confirmed line:
--     a clip by its measured output seconds (capped at the seconds it was confirmed for) times the rate it was confirmed at, with the
--     line's minimum; a key frame or the narration at its confirmed line. A failed take is charged 0. The segment settles once:
--     capture_credits(ref, sum of the charges) — never above the hold (allow_over false) — and 0020 releases the rest in the same
--     transaction; a segment that charged nothing is release_credits(ref). A cancel marks every take that has not begun as skipped
--     (charged 0) and settles at once when nothing is in flight.
--   * MODERATION (Scout 2026-11-14). A vendor that bills a moderated task makes a moderated take cost what the vendor charged:
--     Runway (adapter video.runway: "Moderated generations have the same credit cost as successful generations", RW3) — the take is
--     charged its confirmed line, and charge_basis says `moderated_vendor_billed`. HappyHorse and Seedance state that a failed or
--     moderated task is not billed: charged 0 (`moderated_vendor_not_billed`). Every other vendor (MiniMax, Kling, LTX) does not say:
--     the customer is charged 0 and the record says `moderated_vendor_billing_unknown` (the platform carries what it does not know).
--   * TIME. 0020 releases a hold never started within 3 hours, or started more than 24 hours ago. A worker's first claim starts the hold
--     (start_credit_reservation) and gives the segment a deadline 20 hours later; film_expire_segments settles a segment past it, and
--     a segment nobody claimed within 3 hours, so a hold never expires under a half-made film.
--   * THE OPERATOR'S ORGANIZATION IS EXEMPT (0020): reserve_credits holds nothing there; the segment says exempt and has no hold. Only a
--     platform owner or admin may start a film there (the platform pays), as 0036 and 0073 require.
--
-- LOCK ORDER (every function here): the organization's start lock (start_film only) -> the film row (FOR NO KEY UPDATE) -> the
--   segment -> its takes -> the credit account (inside reserve_credits / capture_credits / release_credits). The worker's claim
--   takes the film and the segment with SKIP LOCKED, in the same order.
--
-- WHO MAY DO WHAT
--   quote_film: editors and above (a viewer reads the film, not its price path). start_film: owners and admins (0020's rule for a
--   paid run); in the exempt organization a platform owner or admin. Both are rate-limited in the database per person (db.film.quote
--   120 an hour, db.film.start 10 an hour). Every other function here is executable by the service role only, or by nobody.
--   film_segments, org_film_settings: members read (column grants; never the request hash); no API role writes them, the service key
--   included. film_takes' new money columns are granted to members (it is the price they confirmed). A browser cannot create a
--   creative job with payer 'film' (no API role inserts into creative_jobs; create_creative_job writes 'credits' only).
--   org_film_settings has no write function yet: the default (no cap, one film at a time) holds until a later migration gives an
--   admin an audited setter. The operator may set a row in the SQL editor as the table owner.
--
-- ERRORS (SQLSTATE; the message is the machine word the app maps; detail says what and how to fix it)
--   42501 forbidden · P0002 not_found
--   NS400 invalid_params | invalid_idempotency_key | cap_exceeded | limit_reached | <a quote refusal's own word, e.g. unpriced>
--   NS402 insufficient credits (reserve_credits, 0020: detail available=… needed=…)
--   NS409 film_changed | price_changed | film_not_editable | film_not_startable | idempotency_conflict | lease_lost | not_running |
--         take_not_planned | take_not_running | takes_in_flight | not_complete | segment_settled
--   NS429 rate_limited · the plan's parallel runs are all in use (0034's hold trigger)
--
-- REQUIRES 0166 (films), 0020/0034/0094 (credits), 0036 (creative_jobs), 0159 (creative_price), 0073's pattern. Additive and idempotent:
-- guarded creates, drop-then-add checks of this file's own names, two constraints REPLACED by supersets (films_status_check gains
-- 'queued', creative_jobs_payer_check gains 'film'), each refused when the live one is neither the earlier file's nor this file's, and
-- create-or-replace functions of this file's own names, each refused if it is not this file's body.
--
-- APPLY AS ONE TRANSACTION (SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1): `set local lock_timeout`
-- assumes it, and the last block asserts the end state.
-- Number: provisionally 0171 (0167, 0168 and 0170 are merged; 0169 is an open pull request); renumber at merge. It replaces no credit
-- function, so 0167's credit_transactions_apply_lots and refund_purchased_credits are untouched. Rollback: docs/sql/rollback_0171_films_money.sql.

set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
  d text;
begin
  if to_regclass('public.films') is null or to_regclass('public.film_takes') is null or to_regclass('public.film_events') is null
     or to_regprocedure('public.film_log(uuid, uuid, uuid, text, jsonb)') is null
     or to_regprocedure('public.film_check_model(text, text[], text)') is null
     or to_regprocedure('public.film_take_rate(text, integer)') is null
     or to_regprocedure('public.film_is_editable(text)') is null
     or to_regprocedure('public.film_asset_live(uuid, uuid, text)') is null then
    raise exception '0171 needs Film Studio P1: apply 0166_films_core.sql first';
  end if;
  if to_regprocedure('public.reserve_credits(uuid, text, numeric)') is null
     or to_regprocedure('public.capture_credits(text, numeric, boolean)') is null
     or to_regprocedure('public.release_credits(text)') is null
     or to_regprocedure('public.start_credit_reservation(text, uuid)') is null
     or to_regprocedure('public.credits_exempt(uuid)') is null
     or to_regprocedure('public.credits_round_up(numeric)') is null
     or to_regprocedure('public.org_run_slots(uuid)') is null then
    raise exception '0171 needs the credits ledger: apply 0020_credits.sql and 0034_plans_entitlements.sql first';
  end if;
  if to_regprocedure('public.creative_price(uuid, text, text, jsonb)') is null
     or to_regprocedure('public.creative_picture_problem(uuid, uuid, text)') is null
     or to_regprocedure('public.creative_refuse(text, text, text)') is null
     or to_regclass('public.creative_jobs') is null or to_regclass('public.model_registry') is null then
    raise exception '0171 needs creative_price (0159) and the creative jobs (0036, 0052): apply them first';
  end if;
  -- The tables this file creates: absent, or this file's own.
  for r in select * from (values ('film_segments', 'assembly_confirmed_credits'), ('org_film_settings', 'max_active_films')) v(t, c) loop
    if to_regclass('public.' || r.t) is not null
       and not exists (select 1 from information_schema.columns
                        where table_schema = 'public' and table_name = r.t and column_name = r.c) then
      raise exception '0171 found a table public.% that is not this file''s (no column %): read it first', r.t, r.c;
    end if;
  end loop;
  -- The two constraints this file replaces: the earlier file's, or this file's (a replay). Read by what they name, not by their text,
  -- which PostgreSQL versions print differently.
  select pg_get_constraintdef(oid) into d from pg_constraint
   where conrelid = 'public.films'::regclass and conname = 'films_status_check';
  if d is null or d not like '%''archived''%' or d not like '%pause_reason%' or d not like '%archived_at%' then
    raise exception '0171 found films_status_check that is not 0166''s or this file''s (%): read it first', d;
  end if;
  select pg_get_constraintdef(oid) into d from pg_constraint
   where conrelid = 'public.creative_jobs'::regclass and conname = 'creative_jobs_payer_check';
  if d is null or d not like '%''credits''%' or d not like '%''api_balance''%' then
    raise exception '0171 found creative_jobs_payer_check that is not 0036''s or this file''s (%): read it first', d;
  end if;
  -- The functions this file creates: absent, or this file's own bodies (a replay).
  for r in select * from (values
      ('public.film_money_limits()', '0035818974235db17ff7667d0526dc18'),
      ('public.film_settings_of(uuid)', '95adf28cbabbc40c16370b52dfbe27c0'),
      ('public.film_moderation_billing(text)', '388e9371d104629e56e3255939d2180e'),
      ('public.film_stand_in(uuid)', 'c6ffddf994a7a0edeaa88b0f41eceb17'),
      ('public.film_model_problem(text, text[], text)', 'd828ee349aa5da3aa05ea9db4d8f1b94'),
      ('public.film_try_price(uuid, text, text, jsonb)', '6f3ef9a01318ce782acf86fd2fd30e33'),
      ('public.film_price(public.films)', 'd06cf0e0b2bcbcbbb67dec33c1d34e23'),
      ('public.film_segment_json(public.film_segments)', '2e9cb9159f169b94998d6a6b388a4cc8'),
      ('public.film_take_money_json(public.film_takes)', 'f77066ee14e4196c190edc53056d7ad7'),
      ('public.film_settle_locked(uuid, uuid, text)', 'a4d7ac1f3137ce51d597802f1697be48'),
      ('public.film_lock_segment(uuid, text, boolean)', '053dc28514bf28fbdcdd1de097418f88'),
      ('public.film_lock_take(uuid, text)', '099be6f8255fa8cf59e2c2444d3b1a21'),
      ('public.quote_film(uuid, integer)', '62d08b9f018e5fb40a9b2ad3fb215e68'),
      ('public.start_film(uuid, text, text)', '18b1c922a17dfa6ab7c0d950acd90fa3'),
      ('public.film_claim_segment(text, interval)', 'bd6bba1a79b8cb770fda4cc106137bde'),
      ('public.film_heartbeat_segment(uuid, text)', '17b89822d95a918a043229482591163b'),
      ('public.film_begin_take(uuid, text)', 'f7b926dcd9e441f7e21cee4f2111333a'),
      ('public.film_take_succeeded(uuid, text, numeric, uuid, uuid)', 'f3cf4dcd93b4057c54645ca0639942c4'),
      ('public.film_take_failed(uuid, text, text, text, text)', '26bbde0ee9bc86409143d23461645fab'),
      ('public.film_begin_assembly(uuid, text)', '1a4c2a27d89f4f1a062d7c3a602e0f30'),
      ('public.film_record_assembly(uuid, text, boolean, numeric)', '7d58188d203a5c7986212a845920ea90'),
      ('public.film_settle_segment(uuid, text, text)', '93b5cd4b8b2fc02efeb42b12b56eb38f'),
      ('public.film_cancel_segment(uuid, text)', '90f06e840094949886f79cd7ab2fce46'),
      ('public.film_expire_segments()', '5f9a51a09f177589801133703ba156a0')) v(sig, want) loop
    -- (Before PostgreSQL 16, to_regprocedure raises for an argument type that does not exist instead of answering NULL.)
    if r.sig like '%public.film\_segments%' and to_regtype('public.film_segments') is null then
      continue;
    end if;
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is not null and h <> r.want then
      raise exception '0171 found % with a body that is not this file''s (md5 %): read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables and columns
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.org_film_settings (
  org_id               uuid primary key references public.organizations (id) on delete restrict,
  -- NULL: no cap beyond the organization's credits. Set: no film whose total is above it may start.
  max_credits_per_film numeric(14,2),
  max_active_films     integer not null default 1,
  updated_by           uuid,
  updated_at           timestamptz not null default now()
);

alter table public.org_film_settings drop constraint if exists org_film_settings_check;
alter table public.org_film_settings add constraint org_film_settings_check
  check ((max_credits_per_film is null or max_credits_per_film > 0) and max_active_films between 1 and 10);

comment on table public.org_film_settings is
  'Film Studio settings of an organization (migration 0171): a per-film credit cap and how many films may run at once. No row = no cap and one film at a time. No API role writes it.';

create table if not exists public.film_segments (
  id                         uuid primary key default gen_random_uuid(),
  film_id                    uuid not null,
  org_id                     uuid not null,
  -- 1 for the first start of a film; a later resume or re-shoot (a later migration) is the next number.
  n                          integer not null,
  purpose                    text not null default 'initial',
  film_version               integer not null,
  quote_id                   text not null,
  status                     text not null default 'queued',
  -- 'fm-' || the id without dashes: the credit_reservations.job_id that pays for this segment. NULL: the exempt organization, or a
  -- total of 0 (an admin priced every line at 0), which holds nothing.
  credit_ref                 text,
  exempt                     boolean not null default false,
  confirmed_credits          numeric(14,2) not null,
  -- What the ledger moved when the segment settled: capture_credits' own answer, never our sum (a hold 0020 already expired captures
  -- nothing, and the record says so).
  captured_credits           numeric(14,2),
  assembly_minutes           integer not null,
  assembly_unit_credits      numeric(18,8) not null,
  assembly_confirmed_credits numeric(14,2) not null,
  assembly_status            text not null default 'planned',
  assembly_output_seconds    numeric(8,2),
  assembly_charged_credits   numeric(14,2),
  worker_id                  text,
  heartbeat_at               timestamptz,
  claimed_at                 timestamptz,
  attempts                   integer not null default 0,
  max_attempts               integer not null default 3,
  deadline_at                timestamptz,
  settle_reason              text,
  idempotency_key            text not null,
  request_hash               text not null,
  created_by                 uuid,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  settled_at                 timestamptz,
  constraint film_segments_film_fk
    foreign key (film_id, org_id) references public.films (id, org_id) on delete restrict
);

alter table public.film_segments drop constraint if exists film_segments_state_check;
alter table public.film_segments add constraint film_segments_state_check
  check (n >= 1 and film_version >= 1
         and purpose in ('initial')
         and status in ('queued', 'running', 'draining', 'settled', 'released')
         and ((status in ('settled', 'released')) = (settled_at is not null))
         and ((status in ('settled', 'released')) = (captured_credits is not null))
         and (settle_reason is null or settle_reason ~ '^[a-z][a-z0-9_]{0,63}$')
         and (status <> 'queued' or (worker_id is null and claimed_at is null))
         and attempts between 0 and 10 and max_attempts between 1 and 10
         and (worker_id is null or char_length(worker_id) between 1 and 120));
alter table public.film_segments drop constraint if exists film_segments_money_check;
alter table public.film_segments add constraint film_segments_money_check
  check (quote_id ~ '^fq-[0-9]{1,9}-[0-9a-f]{32}$'
         and (credit_ref is null or credit_ref ~ '^fm-[0-9a-f]{32}$')
         and (not exempt or credit_ref is null)
         and confirmed_credits >= 0
         and (captured_credits is null or captured_credits between 0 and confirmed_credits)
         and assembly_minutes between 1 and 20
         and assembly_unit_credits >= 0
         and assembly_confirmed_credits between 0 and confirmed_credits
         and assembly_status in ('planned', 'running', 'completed', 'failed', 'skipped')
         and ((assembly_status in ('completed', 'failed', 'skipped')) = (assembly_charged_credits is not null))
         and (assembly_charged_credits is null or assembly_charged_credits between 0 and assembly_confirmed_credits)
         and (assembly_output_seconds is null or (assembly_output_seconds > 0 and assembly_output_seconds <= 3600)));
alter table public.film_segments drop constraint if exists film_segments_bookkeeping_check;
alter table public.film_segments add constraint film_segments_bookkeeping_check
  check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$' and request_hash ~ '^[0-9a-f]{32}$');

-- A take names its film's own segment, never another film's (the composite key below).
create unique index if not exists film_segments_id_film_key on public.film_segments (id, film_id);
create unique index if not exists film_segments_org_idempotency_key on public.film_segments (org_id, idempotency_key);
create unique index if not exists film_segments_film_n_key on public.film_segments (film_id, n);
-- One live segment a film: two holds can never pay for one film at once.
create unique index if not exists film_segments_live_key on public.film_segments (film_id)
  where status in ('queued', 'running', 'draining');
create unique index if not exists film_segments_credit_ref_key on public.film_segments (credit_ref) where credit_ref is not null;
create index if not exists film_segments_queue_idx on public.film_segments (status, created_at)
  where status in ('queued', 'running', 'draining');
create index if not exists film_segments_org_idx on public.film_segments (org_id, created_at desc);

comment on table public.film_segments is
  'One funding hold of a film (migration 0171): the confirmed total, the credit hold fm-<id> that pays for it, the assembly line and the worker''s lease. Written only by start_film and the Film Studio service functions; read by members of the organization.';

alter table public.film_takes add column if not exists segment_id uuid;
alter table public.film_takes add column if not exists credit_unit text;
alter table public.film_takes add column if not exists unit_credits numeric(18,8);
alter table public.film_takes add column if not exists quantity numeric(14,4);
alter table public.film_takes add column if not exists minimum_credits numeric(14,2);
alter table public.film_takes add column if not exists confirmed_credits numeric(14,2);
alter table public.film_takes add column if not exists charged_credits numeric(14,2);
alter table public.film_takes add column if not exists charge_basis text;
alter table public.film_takes add column if not exists output_seconds numeric(8,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.film_takes'::regclass and conname = 'film_takes_segment_fk') then
    alter table public.film_takes add constraint film_takes_segment_fk
      foreign key (segment_id, film_id) references public.film_segments (id, film_id) on delete restrict;
  end if;
end $$;

alter table public.film_takes drop constraint if exists film_takes_money_check;
alter table public.film_takes add constraint film_takes_money_check
  -- A take is priced exactly when a segment pays for it; it is charged once, when it ends, never above its line.
  check (((segment_id is null) = (confirmed_credits is null))
         and ((segment_id is null) = (unit_credits is null))
         and ((segment_id is null) = (quantity is null))
         and ((segment_id is null) = (minimum_credits is null))
         and ((segment_id is null) = (credit_unit is null))
         and (credit_unit is null or credit_unit ~ '^[a-z][a-z0-9_]{0,62}$')
         and (confirmed_credits is null or confirmed_credits >= 0)
         and (unit_credits is null or unit_credits >= 0)
         and (quantity is null or quantity > 0)
         and (minimum_credits is null or minimum_credits >= 0)
         and (charged_credits is null or (confirmed_credits is not null and charged_credits between 0 and confirmed_credits))
         and ((charged_credits is null) = (charge_basis is null))
         and (charge_basis is null or charge_basis ~ '^[a-z][a-z0-9_]{0,63}$')
         and (segment_id is null or status in ('planned', 'queued', 'running') or charged_credits is not null)
         and (charged_credits is null or status in ('completed', 'failed', 'skipped', 'superseded'))
         and (output_seconds is null or (output_seconds > 0 and output_seconds <= 600)));

create index if not exists film_takes_segment_idx on public.film_takes (segment_id, status) where segment_id is not null;

-- A creative job made for a film take (P3's worker creates it). payer 'film' names its take and has no hold of its own: the take's
-- segment holds the money, and finish_creative_job captures only for payer 'credits' (0126), so a film job never settles twice.
alter table public.creative_jobs add column if not exists film_take_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.creative_jobs'::regclass and conname = 'creative_jobs_film_take_fk') then
    alter table public.creative_jobs add constraint creative_jobs_film_take_fk
      foreign key (film_take_id) references public.film_takes (id) on delete restrict;
  end if;
end $$;
create unique index if not exists creative_jobs_film_take_key on public.creative_jobs (film_take_id) where film_take_id is not null;
alter table public.creative_jobs drop constraint if exists creative_jobs_payer_check;
alter table public.creative_jobs add constraint creative_jobs_payer_check
  check (payer in ('credits', 'api_balance', 'film'));
alter table public.creative_jobs drop constraint if exists creative_jobs_film_payer_check;
alter table public.creative_jobs add constraint creative_jobs_film_payer_check
  check (((payer = 'film') = (film_take_id is not null)) and (payer <> 'film' or credit_ref is null));
comment on column public.creative_jobs.film_take_id is
  'The Film Studio take this job makes (migration 0171). Set exactly when payer = ''film''; such a job has no hold of its own (the take''s film_segments hold pays).';

-- 0166's status check with 'queued' added: a film whose hold is taken and that waits for a worker. Everything else is 0166's.
alter table public.films drop constraint if exists films_status_check;
alter table public.films add constraint films_status_check
  check (status in ('draft', 'planning', 'planned', 'queued', 'running', 'draining', 'paused', 'assembling', 'ready',
                    'failed', 'cancelled', 'archived')
         and (pause_reason is null or pause_reason ~ '^[a-z][a-z0-9_]{0,63}$')
         and (pause_detail is null or public.film_text_ok(pause_detail, 1, 500, false))
         and ((status = 'archived') = (archived_at is not null)));

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- The numbers of this file, once (the app reads them from the quote).
create or replace function public.film_money_limits() returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('quotes_per_hour', 120, 'starts_per_hour', 10, 'deadline_hours', 20, 'unclaimed_hours', 3,
                            'stale_minutes', 10, 'max_attempts', 3, 'tts_sample_chars', 4000)
$$;

-- The organization's settings, with the defaults of a missing row.
create or replace function public.film_settings_of(p_org uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'max_credits_per_film', (select s.max_credits_per_film from public.org_film_settings s where s.org_id = p_org),
    'max_active_films', coalesce((select s.max_active_films from public.org_film_settings s where s.org_id = p_org), 1))
$$;

-- Whether the vendor behind a model bills a task its moderation refused (Scout, 2026-11-14): 'billed' (Runway, RW3: "the same credit
-- cost as successful generations"), 'not_billed' (HappyHorse, HH2; Seedance, SD4 — never offered, listed for completeness) or
-- 'unknown' (every vendor that does not say: MiniMax, Kling, LTX, ...). Read from the adapter, which names the vendor's API.
create or replace function public.film_moderation_billing(p_model text) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select case when m.adapter = 'video.runway' then 'billed'
                               when m.adapter = 'video.happyhorse' or m.adapter like 'video.seedance%' then 'not_billed'
                          end
                     from public.model_registry m where m.id = p_model), 'unknown')
$$;

-- A usable picture of the film's organization, to price a clip whose first (or last) frame does not exist yet. The price does not
-- depend on which picture (i2v is priced by its seconds), as in 0073. NULL: the library has none, and the clip is unpriced.
create or replace function public.film_stand_in(p_org uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select a.id from public.media_assets a
   where a.org_id = p_org and a.kind = 'image' and a.deleted_at is null and a.purged_at is null
     and public.creative_picture_problem(p_org, a.id, 'source_asset_id') is null
   order by a.created_at desc, a.id
   limit 1
$$;

-- The model a line needs, checked again for its role (0166's film_check_model: never Seedance, on sale now), as a refusal object
-- {priced: false, reason, detail} or NULL when it may be used. Only that function's refusals (NS400) are caught.
create or replace function public.film_model_problem(p_model text, p_caps text[], p_field text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  w text;
  d text;
begin
  begin
    perform public.film_check_model(p_model, p_caps, p_field);
  exception when sqlstate 'NS400' then
    get stacked diagnostics w = message_text, d = pg_exception_detail;
    return jsonb_build_object('priced', false, 'reason', case when w ~ '^[a-z0-9_]{1,64}$' then w else 'model_not_available' end,
                              'detail', left(coalesce(nullif(d, ''), w), 300));
  end;
  return null;
end
$$;

-- One line priced by creative_price (0159), the Studio's own quote. A refusal is answered as {priced: false, reason, detail} with the
-- database's own word; only its refusals (NS400) are caught, so an unexpected error still stops the quote instead of reading as
-- "unpriced".
create or replace function public.film_try_price(p_org uuid, p_capability text, p_model text, p_params jsonb)
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  q jsonb;
  w text;
  d text;
begin
  begin
    q := public.creative_price(p_org, p_capability, p_model, p_params);
  exception when sqlstate 'NS400' then
    get stacked diagnostics w = message_text, d = pg_exception_detail;
    return jsonb_build_object('priced', false, 'reason', case when w ~ '^[a-z0-9_]{1,64}$' then w else 'unpriced' end,
                              'detail', left(coalesce(nullif(d, ''), w), 300));
  end;
  return q || jsonb_build_object('priced', true);
end
$$;

-- The price of the film as it stands, line by line. Every line is priced from the backend's own rates (see the header); a line that
-- cannot be priced carries its reason and makes the total NULL. Reads only; holds nothing.
create or replace function public.film_price(p_film public.films) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f        public.films := p_film;
  sc       record;
  lines    jsonb := '[]'::jsonb;
  refusals jsonb := '[]'::jsonb;
  scenes_  jsonb := '[]'::jsonb;
  ln       jsonb;
  q        jsonb;
  bad      jsonb;
  params   jsonb;
  stand    uuid := public.film_stand_in(p_film.org_id);
  kmodel   text;
  cmodel   text;
  caps     text[];
  spec     jsonb;
  cap      text;
  refs_n   integer;
  ref_max  integer;
  target   numeric;
  dur      numeric;
  longest  numeric;
  sub      numeric;
  sub_ok   boolean;
  i        integer;
  total    numeric := 0;
  chars    integer;
  seconds  integer;
  minutes  integer;
  rate     public.credit_prices;
  sample   text;
  credits  numeric;
  res      text;
  label    text;
  n_scenes integer := 0;
begin
  for sc in select s.* from public.film_scenes s where s.film_id = f.id order by s.position loop
    n_scenes := n_scenes + 1;
    label := format('scene %s', sc.position + 1);
    sub := 0;
    sub_ok := true;
    kmodel := coalesce(sc.keyframe_model, f.keyframe_model);
    cmodel := coalesce(sc.clip_model, f.clip_model);

    -- The key frame (only a scene that makes its own).
    if sc.first_frame = 'keyframe' then
      ln := jsonb_build_object('line', 'keyframe', 'scene_id', sc.id, 'position', sc.position, 'shot_index', 0, 'model', kmodel);
      q := case when kmodel is not null then public.film_model_problem(kmodel, array['t2i', 'edit'], label || ' keyframe_model') end;
      if kmodel is null then
        ln := ln || jsonb_build_object('priced', false, 'reason', 'model_not_set',
                                       'detail', format('%s: choose a key-frame model', label));
      elsif q is not null then
        ln := ln || q;
      elsif btrim(sc.visual_prompt) = '' then
        ln := ln || jsonb_build_object('priced', false, 'reason', 'prompt_missing',
                                       'detail', format('%s: a key frame is made from the visual prompt; write one', label));
      else
        select m.capabilities, m.spec into caps, spec from public.model_registry m where m.id = kmodel;
        cap := case when 't2i' = any (coalesce(caps, '{}')) then 't2i' else 'edit' end;
        -- The references reach a clip through its key frame (0166): a model that cannot take them all is refused, never handed
        -- fewer than the person chose (CLAUDE.md #4).
        refs_n := (select count(*) from public.film_refs r where r.film_id = f.id and (r.scene_id is null or r.scene_id = sc.id));
        ref_max := case when jsonb_typeof(spec -> 'inputs' -> 'image_refs_max') = 'number'
                        then (spec -> 'inputs' ->> 'image_refs_max')::numeric::integer else 0 end;
        params := jsonb_build_object('prompt', sc.visual_prompt, 'aspect_ratio', f.aspect)
                  || case when f.style_kit_id is null then '{}'::jsonb else jsonb_build_object('style_kit_id', f.style_kit_id) end
                  || case when cap = 'edit' and stand is not null then jsonb_build_object('source_asset_id', stand) else '{}'::jsonb end;
        if refs_n > ref_max then
          q := jsonb_build_object('priced', false, 'reason', 'refs_not_supported',
                                  'detail', format('%s: %s takes %s reference pictures and this scene has %s; choose a model that takes them all or remove some',
                                                   label, kmodel, ref_max, refs_n));
        elsif cap = 'edit' and stand is null then
          q := jsonb_build_object('priced', false, 'reason', 'source_unavailable',
                                  'detail', format('%s: an edit model is priced against a picture of this library; add one picture', label));
        else
          q := public.film_try_price(f.org_id, cap, kmodel, params);
        end if;
        ln := ln || jsonb_build_object('capability', cap, 'params', params - 'prompt' - 'source_asset_id') || q;
      end if;
      lines := lines || jsonb_build_array(ln);
    elsif sc.first_frame = 'asset' and not public.film_asset_live(f.org_id, sc.first_frame_asset_id, 'image') then
      refusals := refusals || jsonb_build_array(jsonb_build_object(
        'line', 'scene', 'scene_id', sc.id, 'position', sc.position, 'reason', 'asset_not_usable',
        'detail', format('%s: its first frame is no longer in the library; choose another picture', label)));
      sub_ok := false;
    end if;
    if sc.last_frame = 'asset' and not public.film_asset_live(f.org_id, sc.last_frame_asset_id, 'image') then
      refusals := refusals || jsonb_build_array(jsonb_build_object(
        'line', 'scene', 'scene_id', sc.id, 'position', sc.position, 'reason', 'asset_not_usable',
        'detail', format('%s: its last frame is no longer in the library; choose another picture', label)));
      sub_ok := false;
    end if;

    -- The clip shots: shot 1 from the first frame, shots 2-3 extend from the shot before.
    select m.spec into spec from public.model_registry m where m.id = cmodel;
    bad := case when cmodel is not null then public.film_model_problem(cmodel, array['i2v'], label || ' clip_model') end;
    target := ceil(sc.planned_seconds::numeric / sc.shot_count);
    select min(x::numeric) filter (where x::numeric >= target), max(x::numeric) into dur, longest
      from jsonb_array_elements_text(case when jsonb_typeof(spec -> 'durations_s') = 'array' then spec -> 'durations_s'
                                          else '[]'::jsonb end) x
     where x ~ '^[0-9]{1,3}(\.[0-9]+)?$';
    for i in 1 .. sc.shot_count loop
      ln := jsonb_build_object('line', case when i = 1 then 'clip' else 'extend' end, 'scene_id', sc.id, 'position', sc.position,
                               'shot_index', i, 'model', cmodel, 'capability', 'i2v');
      if cmodel is null then
        q := jsonb_build_object('priced', false, 'reason', 'model_not_set', 'detail', format('%s: choose a clip model', label));
      elsif bad is not null then
        q := bad;
      elsif dur is null then
        q := jsonb_build_object('priced', false, 'reason', 'scene_too_long_for_model',
                                'detail', case when longest is null
                                               then format('%s: %s lists no clip lengths', label, cmodel)
                                               else format('%s: %s makes at most %s s a shot, and %s s over %s shots needs %s s; give the scene more shots or fewer seconds',
                                                           label, cmodel, longest, sc.planned_seconds, sc.shot_count, target) end);
      elsif stand is null then
        q := jsonb_build_object('priced', false, 'reason', 'source_unavailable',
                                'detail', format('%s: a clip is priced against a picture of this library; add one picture', label));
      else
        res := coalesce(sc.clip_params ->> 'resolution', f.resolution);
        params := jsonb_build_object('source_asset_id', stand, 'duration_s', dur)
                  || case when res is null then '{}'::jsonb else jsonb_build_object('resolution', res) end
                  || case when sc.clip_params ? 'audio' then jsonb_build_object('audio', sc.clip_params -> 'audio') else '{}'::jsonb end
                  || case when i = sc.shot_count and sc.last_frame <> 'none' then jsonb_build_object('end_asset_id', stand)
                          else '{}'::jsonb end;
        q := public.film_try_price(f.org_id, 'i2v', cmodel, params);
        ln := ln || jsonb_build_object('duration_s', dur,
                                       'params', (params - 'source_asset_id' - 'end_asset_id')
                                                 || case when params ? 'end_asset_id' then '{"end_frame": true}'::jsonb else '{}'::jsonb end);
      end if;
      lines := lines || jsonb_build_array(ln || q);
    end loop;

    -- The scene's subtotal: NULL when any of its lines is.
    select coalesce(bool_and((l ->> 'priced')::boolean), true) and sub_ok, sum((l ->> 'credits')::numeric)
      into sub_ok, sub
      from jsonb_array_elements(lines) l where l ->> 'scene_id' = sc.id::text;
    scenes_ := scenes_ || jsonb_build_array(jsonb_build_object(
      'scene_id', sc.id, 'position', sc.position, 'priced', sub_ok, 'credits', case when sub_ok then coalesce(sub, 0) end));
  end loop;
  if n_scenes = 0 then
    refusals := refusals || jsonb_build_array(jsonb_build_object('line', 'film', 'reason', 'no_scenes',
                                                                 'detail', 'the film has no scenes yet; add at least one'));
  end if;

  -- A reference that no longer exists is refused here, never dropped (0166: "the quote refuses it").
  if exists (select 1 from public.film_refs r where r.film_id = f.id
                and ((r.character_id is not null
                      and not exists (select 1 from public.characters c where c.id = r.character_id and c.org_id = r.org_id))
                     or (r.asset_id is not null and not public.film_asset_live(r.org_id, r.asset_id, 'image')))) then
    refusals := refusals || jsonb_build_array(jsonb_build_object('line', 'film', 'reason', 'reference_missing',
      'detail', 'a reference picture or character no longer exists; remove it or choose another'));
  end if;

  -- The narration: one film-level take of every scene's narration, at the voice model's rate as charged (see the header).
  select coalesce(sum(char_length(s.narration)), 0), min(s.narration) filter (where s.narration <> '')
    into chars, sample from public.film_scenes s where s.film_id = f.id;
  if chars > 0 then
    ln := jsonb_build_object('line', 'narration', 'scene_id', null, 'position', null, 'shot_index', 0,
                             'model', f.voice ->> 'model', 'capability', 'tts', 'quantity', chars);
    if f.voice is null then
      q := jsonb_build_object('priced', false, 'reason', 'voice_not_set', 'detail', 'the narration needs a voice; choose one');
    elsif f.voice ->> 'source' = 'channel' then
      q := jsonb_build_object('priced', false, 'reason', 'channel_voice_not_priced',
                              'detail', 'a channel''s own voice is not priced here; choose a voice for the film');
    else
      q := coalesce(public.film_model_problem(f.voice ->> 'model', array['tts'], 'voice.model'),
                    public.film_try_price(f.org_id, 'tts', f.voice ->> 'model',
                                          jsonb_build_object('prompt', left(sample, (public.film_money_limits() ->> 'tts_sample_chars')::integer),
                                                             'voice_id', f.voice ->> 'voice_id')));
      if (q ->> 'priced')::boolean then
        credits := public.credits_round_up(round(chars * (q ->> 'credits_per_unit')::numeric, 6));
        if credits > 0 then
          credits := greatest(credits, (q ->> 'minimum')::numeric);
        end if;
        q := q || jsonb_build_object('quantity', chars, 'credits', credits);
      end if;
    end if;
    lines := lines || jsonb_build_array(ln || q);
  end if;

  -- The assembly: film_assembly_minute times the planned minutes, rounded up. No row: unpriced, never 0.
  select coalesce(sum(s.planned_seconds), 0) into seconds from public.film_scenes s where s.film_id = f.id;
  minutes := greatest(ceil(seconds / 60.0)::integer, 1);
  select * into rate from public.credit_prices where unit = 'film_assembly_minute';
  ln := jsonb_build_object('line', 'assembly', 'scene_id', null, 'position', null, 'shot_index', null, 'model', null,
                           'capability', null, 'quantity', minutes, 'unit', 'film_assembly_minute', 'minimum', 0);
  if rate.unit is null then
    ln := ln || jsonb_build_object('priced', false, 'reason', 'unpriced',
      'detail', 'film assembly has no credit price yet; a platform admin sets film_assembly_minute on the Credits page');
  else
    ln := ln || jsonb_build_object('priced', true, 'credits_per_unit', rate.credits_per_unit * (1 + rate.margin),
      'credits', public.credits_round_up(round(minutes * rate.credits_per_unit * (1 + rate.margin), 6)));
  end if;
  lines := lines || jsonb_build_array(ln);
  -- An unpriced line says so in its own credits: null, never a missing key a client could read as 0.
  select jsonb_agg(case when (l ->> 'priced')::boolean then l else l || '{"credits": null}'::jsonb end order by o)
    into lines from jsonb_array_elements(lines) with ordinality t(l, o);

  for ln in select l from jsonb_array_elements(lines) l where not (l ->> 'priced')::boolean loop
    refusals := refusals || jsonb_build_array(jsonb_build_object(
      'line', ln ->> 'line', 'scene_id', ln -> 'scene_id', 'position', ln -> 'position', 'shot_index', ln -> 'shot_index',
      'reason', ln ->> 'reason', 'detail', ln ->> 'detail'));
  end loop;
  if jsonb_array_length(refusals) = 0 then
    select sum((l ->> 'credits')::numeric) into total from jsonb_array_elements(lines) l;
  else
    total := null;
  end if;

  return jsonb_build_object(
    'film_id', f.id, 'version', f.version, 'priced', total is not null, 'total', total,
    -- The token start_film must be handed back: the version and an md5 of exactly what was priced (jsonb text is canonical).
    'quote_id', case when total is not null
                     then format('fq-%s-%s', f.version,
                                 md5(jsonb_build_object('film', f.id, 'version', f.version, 'lines', lines, 'total', total)::text)) end,
    'lines', lines, 'scenes', scenes_, 'refusals', refusals,
    'excluded', case when f.captions_mode = 'none' then '[]'::jsonb
                     else jsonb_build_array(jsonb_build_object('line', 'captions', 'reason', 'priced_after_narration',
                            'detail', 'captions are priced by the length of the finished narration, so they are not in this price, and nothing is spent on them under it')) end,
    'planned_seconds', seconds, 'assembly_minutes', minutes);
end
$$;

-- A segment as the app and the worker read it (named columns; never the request hash).
create or replace function public.film_segment_json(s public.film_segments) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', s.id, 'film_id', s.film_id, 'org_id', s.org_id, 'n', s.n, 'purpose', s.purpose, 'film_version', s.film_version,
    'quote_id', s.quote_id, 'status', s.status, 'credit_ref', s.credit_ref, 'exempt', s.exempt,
    'confirmed_credits', s.confirmed_credits, 'captured_credits', s.captured_credits,
    'charged_credits', (select coalesce(sum(t.charged_credits), 0) from public.film_takes t where t.segment_id = s.id)
                       + coalesce(s.assembly_charged_credits, 0),
    'assembly', jsonb_build_object('status', s.assembly_status, 'minutes', s.assembly_minutes,
                                   'credits_per_unit', s.assembly_unit_credits, 'confirmed_credits', s.assembly_confirmed_credits,
                                   'charged_credits', s.assembly_charged_credits, 'output_seconds', s.assembly_output_seconds),
    'takes', (select jsonb_build_object(
                'total', count(*), 'planned', count(*) filter (where t.status in ('planned', 'queued')),
                'running', count(*) filter (where t.status = 'running'),
                'completed', count(*) filter (where t.status = 'completed'),
                'failed', count(*) filter (where t.status = 'failed'), 'skipped', count(*) filter (where t.status = 'skipped'))
                from public.film_takes t where t.segment_id = s.id),
    'worker_id', s.worker_id, 'heartbeat_at', s.heartbeat_at, 'claimed_at', s.claimed_at, 'attempts', s.attempts,
    'max_attempts', s.max_attempts, 'deadline_at', s.deadline_at, 'settle_reason', s.settle_reason,
    'idempotency_key', s.idempotency_key, 'created_by', s.created_by, 'created_at', s.created_at, 'updated_at', s.updated_at,
    'settled_at', s.settled_at)
$$;

-- A take with its money, for the worker (0166's film_take_json, plus the columns this file adds).
create or replace function public.film_take_money_json(t public.film_takes) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select public.film_take_json(t) || jsonb_build_object(
    'segment_id', t.segment_id, 'credit_unit', t.credit_unit, 'unit_credits', t.unit_credits, 'quantity', t.quantity,
    'minimum_credits', t.minimum_credits, 'confirmed_credits', t.confirmed_credits, 'charged_credits', t.charged_credits,
    'charge_basis', t.charge_basis, 'output_seconds', t.output_seconds)
$$;

-- The film and the segment, locked in this file's order, for a worker that holds the lease (or for no worker when p_worker is NULL
-- and p_need_lease is false: cancel and expiry). A stranger's segment and a missing one read the same.
create or replace function public.film_lock_segment(p_segment uuid, p_worker text, p_need_lease boolean)
  returns public.film_segments
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s   public.film_segments;
  fid uuid;
begin
  select x.film_id into fid from public.film_segments x where x.id = p_segment;
  if fid is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform 1 from public.films where id = fid for no key update;
  select * into s from public.film_segments where id = p_segment for update;
  if p_need_lease and s.worker_id is distinct from left(btrim(coalesce(p_worker, '')), 120) then
    perform public.creative_refuse('lease_lost', 'another worker holds this segment now', 'NS409');
  end if;
  return s;
end
$$;

-- The take, its film and its segment, locked in order, for the worker holding the segment's lease.
create or replace function public.film_lock_take(p_take uuid, p_worker text) returns public.film_takes
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t   public.film_takes;
  seg uuid;
begin
  select x.segment_id into seg from public.film_takes x where x.id = p_take;
  if seg is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform public.film_lock_segment(seg, p_worker, true);
  select * into t from public.film_takes where id = p_take for update;
  return t;
end
$$;

-- Settle a segment whose film and segment the caller has locked and that has nothing in flight: every take that never began is
-- skipped (charged 0), the charges are captured once (never above the hold) and the rest released, and the film moves on. The ledger's
-- own answer is recorded, so a hold that 0020 already expired reads as what it captured, not as what was owed.
create or replace function public.film_settle_locked(p_film uuid, p_segment uuid, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s      public.film_segments;
  why    text;
  owed   numeric;
  got    numeric := 0;
  status_ text;
begin
  select * into s from public.film_segments where id = p_segment and film_id = p_film;
  if s.status in ('settled', 'released') then
    return public.film_segment_json(s);
  end if;
  why := coalesce(s.settle_reason, p_reason);
  update public.film_takes
     set status = 'skipped', charged_credits = 0, charge_basis = 'not_started', updated_at = now(), finished_at = now()
   where segment_id = s.id and status in ('planned', 'queued');
  if s.assembly_status = 'planned' then
    update public.film_segments set assembly_status = 'skipped', assembly_charged_credits = 0 where id = s.id;
  end if;
  select * into s from public.film_segments where id = s.id;
  owed := (select coalesce(sum(t.charged_credits), 0) from public.film_takes t where t.segment_id = s.id)
          + coalesce(s.assembly_charged_credits, 0);
  if owed > s.confirmed_credits then
    raise exception 'film_settle_locked: charges % exceed the confirmed % of segment %', owed, s.confirmed_credits, s.id;
  end if;
  if s.credit_ref is not null then
    if owed > 0 then
      got := public.capture_credits(s.credit_ref, owed, false);
    else
      perform public.release_credits(s.credit_ref);
    end if;
  end if;
  status_ := case when got > 0 then 'settled' else 'released' end;
  update public.film_segments
     set status = status_, captured_credits = got, settled_at = now(), settle_reason = why, worker_id = null, updated_at = now()
   where id = s.id
  returning * into s;
  update public.films
     set status = case when why = 'completed' then 'ready' when why = 'cancelled' then 'cancelled' else 'paused' end,
         pause_reason = case when why in ('completed', 'cancelled') then null else why end,
         pause_detail = null, updated_at = now()
   where id = p_film;
  perform public.film_log(p_film, s.org_id, null, 'segment_settled',
    jsonb_build_object('segment_id', s.id, 'reason', why, 'confirmed', s.confirmed_credits, 'charged', owed, 'captured', got,
                       'exempt', s.exempt)
    || case when s.credit_ref is not null and got < owed then jsonb_build_object('not_captured', owed - got) else '{}'::jsonb end);
  return public.film_segment_json(s);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The browser's two calls
-- ───────────────────────────────────────────────────────────────────────────

-- The price of the film at the version the caller read, with what stands in the way of starting it now. Holds nothing.
create or replace function public.quote_film(p_film uuid, p_version integer) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  org      uuid;
  f        public.films;
  q        jsonb;
  st       jsonb;
  acc      public.credit_accounts;
  avail    numeric;
  active   integer;
  slots    jsonb;
  blocked  jsonb := '[]'::jsonb;
  exempt_  boolean;
  may      boolean;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.org_id into org from public.films x where x.id = p_film;
  if org is null or not public.is_org_member(org, 'viewer') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into f from public.films where id = p_film;
  if not public.film_is_editable(f.status) then
    perform public.creative_refuse('film_not_editable', format('a %s film is not quoted again', f.status), 'NS409');
  end if;
  if p_version is distinct from f.version then
    perform public.creative_refuse('film_changed', format('the film is at version %s', f.version), 'NS409');
  end if;
  perform public.film_take_rate('quote', (public.film_money_limits() ->> 'quotes_per_hour')::integer);
  q := public.film_price(f);

  exempt_ := public.credits_exempt(org);
  st := public.film_settings_of(org);
  select * into acc from public.credit_accounts where org_id = org;
  avail := case when exempt_ then null else coalesce(acc.balance - acc.reserved, 0) end;
  active := (select count(*) from public.film_segments s where s.org_id = org and s.status in ('queued', 'running', 'draining'));
  slots := public.org_run_slots(org);
  if (q ->> 'priced')::boolean then
    if st ->> 'max_credits_per_film' is not null and (q ->> 'total')::numeric > (st ->> 'max_credits_per_film')::numeric then
      blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'cap_exceeded', 'limit', st -> 'max_credits_per_film'));
    end if;
    if not exempt_ and (q ->> 'total')::numeric > avail then
      blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'insufficient_credits', 'available', avail,
                                                                 'needed', q -> 'total'));
    end if;
  end if;
  if active >= (st ->> 'max_active_films')::integer then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'limit_reached', 'active', active,
                                                               'limit', st -> 'max_active_films'));
  end if;
  if not exempt_ and slots is not null and (slots ->> 'active')::integer >= (slots ->> 'limit')::integer then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'run_slots_full', 'active', slots -> 'active',
                                                               'limit', slots -> 'limit'));
  end if;
  may := public.is_org_member(org, 'admin') and (not exempt_ or public.is_platform_admin());
  return q || jsonb_build_object(
    'exempt', exempt_, 'available', avail, 'settings', st, 'active_films', active, 'run_slots', slots,
    'blocked_by', blocked, 'may_start', may,
    'startable', (q ->> 'priced')::boolean and jsonb_array_length(blocked) = 0 and may,
    'limits', public.film_money_limits());
end
$$;

-- Start the film at a quote the caller confirmed: re-price it, check the version, the price, the cap and the limits, hold the total
-- (reserve_credits, NS402 when it is not there), create the segment and every planned take, and queue the film. Idempotent on the
-- caller's key: the same key with the same film and quote answers the first segment, with another one it is a conflict.
create or replace function public.start_film(p_film uuid, p_quote_id text, p_idempotency_key text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  org     uuid;
  f       public.films;
  s       public.film_segments;
  q       jsonb;
  st      jsonb;
  ln      jsonb;
  bad     jsonb;
  sid     uuid := gen_random_uuid();
  ref     text;
  exempt_ boolean;
  total   numeric;
  hash    text;
  asm     jsonb;
  n_takes integer := 0;
  v       integer;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.org_id into org from public.films x where x.id = p_film;
  if org is null or not public.is_org_member(org, 'viewer') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  exempt_ := public.credits_exempt(org);
  -- 0020's rule for a paid run; in the exempt organization the platform pays, so only its owner or admin may.
  if not public.is_org_member(org, 'admin') or (exempt_ and not public.is_platform_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$' then
    perform public.creative_refuse('invalid_idempotency_key', 'the idempotency key must be 8 to 128 letters, digits or _.:-');
  end if;
  if p_quote_id is null or p_quote_id !~ '^fq-[0-9]{1,9}-[0-9a-f]{32}$' then
    perform public.creative_refuse('invalid_params', 'quote_id must be the quote_id quote_film answered');
  end if;
  hash := md5(jsonb_build_object('film', p_film, 'quote', p_quote_id)::text);

  -- One start per organization at a time: the replay lookup, the active-film count and the hold cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('film_start:' || org::text, 0));
  select * into s from public.film_segments where org_id = org and idempotency_key = p_idempotency_key;
  if found then
    if s.request_hash <> hash then
      perform public.creative_refuse('idempotency_conflict', 'this idempotency key was used to start another film or quote', 'NS409');
    end if;
    return public.film_segment_json(s) || jsonb_build_object('replayed', true);
  end if;

  select * into f from public.films where id = p_film for no key update;
  if not public.film_is_editable(f.status) then
    perform public.creative_refuse('film_not_startable', format('a %s film cannot be started', f.status), 'NS409');
  end if;
  if split_part(p_quote_id, '-', 2)::integer <> f.version then
    perform public.creative_refuse('film_changed',
      format('the film was edited after this quote (it is at version %s); quote it again', f.version), 'NS409');
  end if;
  perform public.film_take_rate('start', (public.film_money_limits() ->> 'starts_per_hour')::integer);

  q := public.film_price(f);
  if not (q ->> 'priced')::boolean then
    bad := q -> 'refusals' -> 0;
    perform public.creative_refuse(bad ->> 'reason', bad ->> 'detail');
  end if;
  total := (q ->> 'total')::numeric;
  if q ->> 'quote_id' <> p_quote_id then
    perform public.creative_refuse('price_changed', format('the price is now %s credits; quote it again', total), 'NS409');
  end if;
  st := public.film_settings_of(org);
  if st ->> 'max_credits_per_film' is not null and total > (st ->> 'max_credits_per_film')::numeric then
    perform public.creative_refuse('cap_exceeded',
      format('this film costs %s credits and the organization allows %s a film', total, st ->> 'max_credits_per_film'));
  end if;
  if (select count(*) from public.film_segments x where x.org_id = org and x.status in ('queued', 'running', 'draining'))
     >= (st ->> 'max_active_films')::integer then
    perform public.creative_refuse('limit_reached',
      format('at most %s films of this organization run at once; wait for one to finish', st ->> 'max_active_films'));
  end if;

  -- The hold: 0020's reserve_credits in the admin's own session (NS402 with available and needed when the credits are not there;
  -- NS429 when the plan's parallel runs are all in use). Nothing is held in the exempt organization or for a total of 0.
  ref := 'fm-' || replace(sid::text, '-', '');
  if exempt_ or total = 0 then
    ref := null;
  else
    perform public.reserve_credits(org, ref, total);
  end if;

  select l into asm from jsonb_array_elements(q -> 'lines') l where l ->> 'line' = 'assembly';
  insert into public.film_segments (id, film_id, org_id, n, purpose, film_version, quote_id, status, credit_ref, exempt,
                                    confirmed_credits, assembly_minutes, assembly_unit_credits, assembly_confirmed_credits,
                                    max_attempts, idempotency_key, request_hash, created_by)
  values (sid, f.id, org, coalesce((select max(x.n) from public.film_segments x where x.film_id = f.id), 0) + 1, 'initial',
          f.version, p_quote_id, 'queued', ref, exempt_, total, (asm ->> 'quantity')::integer,
          (asm ->> 'credits_per_unit')::numeric, (asm ->> 'credits')::numeric,
          (public.film_money_limits() ->> 'max_attempts')::integer, p_idempotency_key, hash, uid)
  returning * into s;

  for ln in select l from jsonb_array_elements(q -> 'lines') l where l ->> 'line' in ('keyframe', 'clip', 'extend', 'narration') loop
    -- The next version of this scene (or of the film's narration), past every take an earlier segment made.
    v := coalesce((select max(t.version) from public.film_takes t
                    where t.film_id = f.id and t.scene_id is not distinct from (ln ->> 'scene_id')::uuid
                      and t.kind = case when ln ->> 'line' = 'narration' then 'narration' else t.kind end
                      and t.segment_id is distinct from sid), 0) + 1;
    insert into public.film_takes (film_id, org_id, scene_id, version, shot_index, kind, attempt, status, model, params, duration_s,
                                   segment_id, credit_unit, unit_credits, quantity, minimum_credits, confirmed_credits)
    values (f.id, org, (ln ->> 'scene_id')::uuid, v, (ln ->> 'shot_index')::smallint, ln ->> 'line', 1, 'planned', ln ->> 'model',
            coalesce(ln -> 'params', '{}'::jsonb), (ln ->> 'duration_s')::numeric, sid, ln ->> 'unit',
            (ln ->> 'credits_per_unit')::numeric, (ln ->> 'quantity')::numeric, (ln ->> 'minimum')::numeric,
            (ln ->> 'credits')::numeric);
    n_takes := n_takes + 1;
  end loop;

  update public.films set status = 'queued', pause_reason = null, pause_detail = null, updated_at = now() where id = f.id;
  perform public.film_log(f.id, org, null, 'started',
    jsonb_build_object('segment_id', sid, 'quote_id', p_quote_id, 'credits', total, 'held', ref is not null, 'exempt', exempt_,
                       'takes', n_takes, 'version', f.version));
  return public.film_segment_json(s) || jsonb_build_object('replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The worker's state machine (service role only)
-- ───────────────────────────────────────────────────────────────────────────

-- Claim the oldest segment that waits for a worker, or one whose worker stopped beating. The first claim starts the hold (0020:
-- its 24-hour clock runs from here) and sets a 20-hour deadline; a hold that is no longer open (0020 expired it) settles the segment
-- instead, and the next candidate is tried. A segment re-claimed past max_attempts drains (worker_lost). NULL: nothing to do.
create or replace function public.film_claim_segment(p_worker text, p_stale_after interval default interval '10 minutes')
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w    text := left(btrim(coalesce(p_worker, '')), 120);
  c    record;
  s    public.film_segments;
  lim  jsonb := public.film_money_limits();
begin
  if w = '' then
    raise exception 'film_claim_segment: p_worker is required' using errcode = '22023';
  end if;
  if p_stale_after is null or p_stale_after < interval '1 minute' then
    raise exception 'film_claim_segment: p_stale_after must be at least a minute' using errcode = '22023';
  end if;
  for c in select x.id, x.film_id from public.film_segments x
            where x.status = 'queued'
               or (x.status in ('running', 'draining') and (x.heartbeat_at is null or x.heartbeat_at < now() - p_stale_after))
            order by x.created_at, x.id
            limit 20 loop
    perform 1 from public.films where id = c.film_id for no key update skip locked;
    if not found then
      continue;
    end if;
    select * into s from public.film_segments where id = c.id for update skip locked;
    if not found or not (s.status = 'queued'
                         or (s.status in ('running', 'draining') and (s.heartbeat_at is null or s.heartbeat_at < now() - p_stale_after))) then
      continue;
    end if;
    if s.status = 'queued' then
      if s.credit_ref is not null and public.start_credit_reservation(s.credit_ref, s.org_id) is null then
        perform public.film_settle_locked(s.film_id, s.id, 'hold_expired');
        continue;
      end if;
      update public.film_segments
         set status = 'running', claimed_at = now(), deadline_at = now() + make_interval(hours => (lim ->> 'deadline_hours')::integer)
       where id = s.id;
      update public.films set status = 'running', updated_at = now() where id = s.film_id and status = 'queued';
    end if;
    update public.film_segments
       set worker_id = w, heartbeat_at = now(), attempts = attempts + 1, updated_at = now(),
           status = case when attempts + 1 > max_attempts and status = 'running' then 'draining' else status end,
           settle_reason = case when attempts + 1 > max_attempts and settle_reason is null then 'worker_lost' else settle_reason end
     where id = s.id
    returning * into s;
    if s.status = 'draining' then
      update public.films set status = 'draining', updated_at = now() where id = s.film_id and status in ('queued', 'running');
    end if;
    perform public.film_log(s.film_id, s.org_id, null, 'segment_claimed',
                            jsonb_build_object('segment_id', s.id, 'worker', w, 'attempt', s.attempts, 'status', s.status));
    return public.film_segment_json(s) || jsonb_build_object(
      'takes_list', coalesce((select jsonb_agg(public.film_take_money_json(t) order by t.scene_id nulls last, t.shot_index)
                                from public.film_takes t where t.segment_id = s.id), '[]'::jsonb));
  end loop;
  return null;
end
$$;

-- The lease is alive. False: this worker no longer holds the segment and must stop.
create or replace function public.film_heartbeat_segment(p_segment uuid, p_worker text) returns boolean
  language sql volatile security definer set search_path = public, pg_temp as $$
  with u as (
    update public.film_segments
       set heartbeat_at = now()
     where id = p_segment and worker_id = left(btrim(coalesce(p_worker, '')), 120) and status in ('running', 'draining')
    returning 1)
  select exists (select 1 from u)
$$;

-- A planned take is about to cost money: mark it running BEFORE the billable call, so a cancel from now on waits for it instead of
-- releasing its share. Refused once the segment drains (a cancel or a failure: nothing new begins) or is past its deadline.
-- A take already running answers as it is (a retried call).
create or replace function public.film_begin_take(p_take uuid, p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t public.film_takes := public.film_lock_take(p_take, p_worker);
  s public.film_segments;
begin
  select * into s from public.film_segments where id = t.segment_id;
  if t.status = 'running' then
    return public.film_take_money_json(t);
  end if;
  if s.status <> 'running' then
    perform public.creative_refuse('not_running', format('the segment is %s: nothing new begins', s.status), 'NS409');
  end if;
  if s.deadline_at is not null and now() > s.deadline_at then
    perform public.creative_refuse('not_running', 'the segment is past its deadline: settle it', 'NS409');
  end if;
  if t.status <> 'planned' then
    perform public.creative_refuse('take_not_planned', format('the take is %s', t.status), 'NS409');
  end if;
  update public.film_takes set status = 'running', updated_at = now() where id = t.id returning * into t;
  return public.film_take_money_json(t);
end
$$;

-- A take made its result. Its charge is set here, once, never above its confirmed line: a clip by its measured output seconds
-- (capped at the seconds it was confirmed for) at the rate it was confirmed at, with the line's minimum; a key frame or the narration
-- at its line. The result must be a live file of the organization of the right kind. A retried call with the same result answers as
-- it is.
create or replace function public.film_take_succeeded(p_take uuid, p_worker text, p_output_seconds numeric, p_result_asset uuid,
                                                      p_last_frame_asset uuid default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t      public.film_takes := public.film_lock_take(p_take, p_worker);
  s      public.film_segments;
  want   text;
  billed numeric;
  charge numeric;
  basis  text;
begin
  select * into s from public.film_segments where id = t.segment_id;
  if t.status = 'completed' and t.result_asset_id is not distinct from p_result_asset then
    return public.film_take_money_json(t);
  end if;
  if t.status <> 'running' or s.status not in ('running', 'draining') then
    perform public.creative_refuse('take_not_running', format('the take is %s and its segment %s', t.status, s.status), 'NS409');
  end if;
  want := case when t.kind = 'keyframe' then 'image' when t.kind = 'narration' then 'audio' else 'video' end;
  if p_result_asset is null or not public.film_asset_live(t.org_id, p_result_asset, want) then
    perform public.creative_refuse('invalid_params', format('the result must be a live %s of this library', want));
  end if;
  if p_last_frame_asset is not null and not public.film_asset_live(t.org_id, p_last_frame_asset, 'image') then
    perform public.creative_refuse('invalid_params', 'the last frame must be a live image of this library');
  end if;
  if p_output_seconds is not null and (p_output_seconds <= 0 or p_output_seconds > 600) then
    perform public.creative_refuse('invalid_params', 'output_seconds must be more than 0 and at most 600');
  end if;
  if t.kind in ('clip', 'extend') then
    -- Never a default as a measurement (CLAUDE.md #5): a clip is charged by the seconds the file was measured to have.
    if p_output_seconds is null then
      perform public.creative_refuse('invalid_params', 'a clip is charged by its measured output seconds: give output_seconds');
    end if;
    billed := least(p_output_seconds, t.quantity);
    charge := public.credits_round_up(round(billed * t.unit_credits, 6));
    if charge > 0 then
      charge := greatest(charge, t.minimum_credits);
    end if;
    charge := least(charge, t.confirmed_credits);
    basis := 'output_seconds';
  else
    charge := t.confirmed_credits;
    basis := case when t.kind = 'keyframe' then 'per_image' else 'per_character' end;
  end if;
  update public.film_takes
     set status = 'completed', charged_credits = charge, charge_basis = basis, output_seconds = p_output_seconds,
         result_asset_id = p_result_asset, result_last_frame_asset_id = p_last_frame_asset, error_code = null, error = null,
         updated_at = now(), finished_at = now()
   where id = t.id
  returning * into t;
  perform public.film_log(t.film_id, t.org_id, t.scene_id, 'take_completed',
    jsonb_build_object('take_id', t.id, 'kind', t.kind, 'shot_index', t.shot_index, 'confirmed', t.confirmed_credits,
                       'charged', charge, 'basis', basis, 'output_seconds', p_output_seconds));
  return public.film_take_money_json(t);
end
$$;

-- A take failed. A provider error is charged 0 (its share of the hold is released when the segment settles). A moderated task is
-- charged what the vendor charged for it (film_moderation_billing, see the header): its line on a vendor that bills moderation, else
-- 0, and the basis says which. The error text is ours (at most 2,000 characters), never a vendor body. A take that never began may
-- fail too (the worker found its input missing): charged 0. A retried call answers as it is.
create or replace function public.film_take_failed(p_take uuid, p_worker text, p_failure text, p_error_code text,
                                                   p_error text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t      public.film_takes := public.film_lock_take(p_take, p_worker);
  s      public.film_segments;
  bill   text;
  charge numeric := 0;
  basis  text;
begin
  select * into s from public.film_segments where id = t.segment_id;
  if t.status = 'failed' then
    return public.film_take_money_json(t);
  end if;
  if p_failure is null or p_failure not in ('provider_error', 'moderated') then
    perform public.creative_refuse('invalid_params', 'the failure must be provider_error or moderated');
  end if;
  if p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,64}$' then
    perform public.creative_refuse('invalid_params', 'error_code must be a machine word');
  end if;
  if p_error is not null and char_length(p_error) > 2000 then
    perform public.creative_refuse('invalid_params', 'error must be at most 2000 characters');
  end if;
  if s.status not in ('running', 'draining')
     or t.status not in ('planned', 'running')
     or (p_failure = 'moderated' and t.status <> 'running') then
    perform public.creative_refuse('take_not_running', format('the take is %s and its segment %s', t.status, s.status), 'NS409');
  end if;
  if p_failure = 'moderated' then
    bill := public.film_moderation_billing(t.model);
    if bill = 'billed' then
      charge := t.confirmed_credits;
      basis := 'moderated_vendor_billed';
    elsif bill = 'not_billed' then
      basis := 'moderated_vendor_not_billed';
    else
      basis := 'moderated_vendor_billing_unknown';
    end if;
  else
    basis := 'failed_not_charged';
  end if;
  update public.film_takes
     set status = 'failed', charged_credits = charge, charge_basis = basis, error_code = p_error_code, error = p_error,
         updated_at = now(), finished_at = now()
   where id = t.id
  returning * into t;
  perform public.film_log(t.film_id, t.org_id, t.scene_id, 'take_failed',
    jsonb_build_object('take_id', t.id, 'kind', t.kind, 'failure', p_failure, 'error_code', p_error_code,
                       'confirmed', t.confirmed_credits, 'charged', charge, 'basis', basis));
  return public.film_take_money_json(t);
end
$$;

-- The assembly is about to run (it begins only when every take of the segment is completed).
create or replace function public.film_begin_assembly(p_segment uuid, p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.film_segments := public.film_lock_segment(p_segment, p_worker, true);
begin
  if s.assembly_status = 'running' then
    return public.film_segment_json(s);
  end if;
  if s.status <> 'running' or s.assembly_status <> 'planned' then
    perform public.creative_refuse('not_running', format('the segment is %s and its assembly %s', s.status, s.assembly_status), 'NS409');
  end if;
  if exists (select 1 from public.film_takes t where t.segment_id = s.id and t.status <> 'completed') then
    perform public.creative_refuse('not_complete', 'every take must be completed before the assembly', 'NS409');
  end if;
  update public.film_segments set assembly_status = 'running', updated_at = now() where id = s.id returning * into s;
  return public.film_segment_json(s);
end
$$;

-- The assembly ended: charged by its measured length in whole minutes at the confirmed rate, never above its line; 0 on failure.
create or replace function public.film_record_assembly(p_segment uuid, p_worker text, p_ok boolean, p_output_seconds numeric)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s      public.film_segments := public.film_lock_segment(p_segment, p_worker, true);
  charge numeric := 0;
begin
  if s.assembly_status in ('completed', 'failed') then
    return public.film_segment_json(s);
  end if;
  if s.assembly_status <> 'running' or p_ok is null then
    perform public.creative_refuse('not_running', format('the assembly is %s', s.assembly_status), 'NS409');
  end if;
  if p_ok then
    if p_output_seconds is null or p_output_seconds <= 0 or p_output_seconds > 3600 then
      perform public.creative_refuse('invalid_params', 'an assembly is charged by its measured output seconds: give output_seconds');
    end if;
    charge := least(public.credits_round_up(round(ceil(p_output_seconds / 60.0) * s.assembly_unit_credits, 6)),
                    s.assembly_confirmed_credits);
  end if;
  update public.film_segments
     set assembly_status = case when p_ok then 'completed' else 'failed' end, assembly_charged_credits = charge,
         assembly_output_seconds = case when p_ok then p_output_seconds end, updated_at = now()
   where id = s.id
  returning * into s;
  perform public.film_log(s.film_id, s.org_id, null, case when p_ok then 'assembly_completed' else 'assembly_failed' end,
    jsonb_build_object('segment_id', s.id, 'confirmed', s.assembly_confirmed_credits, 'charged', charge,
                       'output_seconds', p_output_seconds));
  return public.film_segment_json(s);
end
$$;

-- Settle the segment: when something is still in flight it drains (nothing new begins) and the worker calls again when it ends;
-- otherwise the charges are captured once and the rest released (film_settle_locked). p_reason 'completed' needs every take and the
-- assembly completed (the film becomes ready); 'cancelled' cancels the film; any other machine word pauses it with that reason.
-- Settling a settled segment answers as it is.
create or replace function public.film_settle_segment(p_segment uuid, p_worker text, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.film_segments := public.film_lock_segment(p_segment, p_worker, false);
begin
  if s.status in ('settled', 'released') then
    return public.film_segment_json(s);
  end if;
  if s.worker_id is not null and s.worker_id is distinct from left(btrim(coalesce(p_worker, '')), 120) then
    perform public.creative_refuse('lease_lost', 'another worker holds this segment now', 'NS409');
  end if;
  if p_reason is null or p_reason !~ '^[a-z][a-z0-9_]{0,63}$' then
    perform public.creative_refuse('invalid_params', 'the reason must be a machine word');
  end if;
  if p_reason = 'completed'
     and (s.assembly_status <> 'completed'
          or exists (select 1 from public.film_takes t where t.segment_id = s.id and t.status <> 'completed')) then
    perform public.creative_refuse('not_complete', 'a completed film needs every take and the assembly completed', 'NS409');
  end if;
  if s.assembly_status = 'running' or exists (select 1 from public.film_takes t where t.segment_id = s.id and t.status = 'running') then
    update public.film_segments
       set status = 'draining', settle_reason = coalesce(settle_reason, p_reason), updated_at = now()
     where id = s.id
    returning * into s;
    update public.films set status = 'draining', updated_at = now() where id = s.film_id and status in ('queued', 'running');
    return public.film_segment_json(s) || jsonb_build_object('settled', false);
  end if;
  return public.film_settle_locked(s.film_id, s.id, p_reason) || jsonb_build_object('settled', true);
end
$$;

-- Cancel: every take that has not begun is skipped (its share of the hold is released), and the segment settles now when nothing is
-- in flight, or drains until the takes in flight end. A segment nobody claimed releases its whole hold. Settled already: as it is.
create or replace function public.film_cancel_segment(p_segment uuid, p_reason text default 'cancelled') returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.film_segments := public.film_lock_segment(p_segment, null, false);
begin
  if s.status in ('settled', 'released') then
    return public.film_segment_json(s);
  end if;
  if p_reason is null or p_reason !~ '^[a-z][a-z0-9_]{0,63}$' or p_reason = 'completed' then
    perform public.creative_refuse('invalid_params', 'the reason must be a machine word other than completed');
  end if;
  update public.film_takes
     set status = 'skipped', charged_credits = 0, charge_basis = 'cancelled_before_start', updated_at = now(), finished_at = now()
   where segment_id = s.id and status in ('planned', 'queued');
  update public.film_segments
     set settle_reason = coalesce(settle_reason, p_reason),
         assembly_status = case when assembly_status = 'planned' then 'skipped' else assembly_status end,
         assembly_charged_credits = case when assembly_status = 'planned' then 0 else assembly_charged_credits end,
         updated_at = now()
   where id = s.id
  returning * into s;
  perform public.film_log(s.film_id, s.org_id, null, 'segment_cancel_requested',
                          jsonb_build_object('segment_id', s.id, 'reason', s.settle_reason));
  if s.assembly_status = 'running' or exists (select 1 from public.film_takes t where t.segment_id = s.id and t.status = 'running') then
    update public.film_segments set status = 'draining', updated_at = now() where id = s.id returning * into s;
    update public.films set status = 'draining', updated_at = now() where id = s.film_id and status in ('queued', 'running');
    return public.film_segment_json(s) || jsonb_build_object('settled', false);
  end if;
  return public.film_settle_locked(s.film_id, s.id, s.settle_reason) || jsonb_build_object('settled', true);
end
$$;

-- The sweep (the worker runs it on its loop): a segment whose hold 0020 no longer keeps open, one nobody claimed within 3 hours, and
-- one past its deadline are cancelled with that reason (drained first when something is in flight), so no hold expires under a film
-- that still reads as running. Returns how many segments it moved.
create or replace function public.film_expire_segments() returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  c   record;
  s   public.film_segments;
  why text;
  n   integer := 0;
  lim jsonb := public.film_money_limits();
begin
  for c in select x.id, x.film_id from public.film_segments x
            where x.status in ('queued', 'running', 'draining') order by x.created_at, x.id loop
    perform 1 from public.films where id = c.film_id for no key update skip locked;
    if not found then
      continue;
    end if;
    select * into s from public.film_segments where id = c.id for update skip locked;
    if not found or s.status not in ('queued', 'running', 'draining') then
      continue;
    end if;
    why := case
      when s.credit_ref is not null
           and not exists (select 1 from public.credit_reservations r where r.job_id = s.credit_ref and r.status = 'open')
        then 'hold_expired'
      when s.status = 'queued' and s.created_at < now() - make_interval(hours => (lim ->> 'unclaimed_hours')::integer)
        then 'worker_unavailable'
      when s.deadline_at is not null and now() > s.deadline_at
        then 'deadline'
    end;
    -- Draining already, with something still in flight: the worker settles it when that ends (no event per sweep).
    if why is null
       or (s.status = 'draining' and (s.assembly_status = 'running'
                                      or exists (select 1 from public.film_takes t where t.segment_id = s.id and t.status = 'running'))) then
      continue;
    end if;
    perform public.film_cancel_segment(s.id, why);
    n := n + 1;
  end loop;
  return n;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.film_segments enable row level security;
alter table public.org_film_settings enable row level security;

revoke all on public.film_segments, public.org_film_settings from public, anon, authenticated, service_role;
grant select on public.film_segments, public.org_film_settings to service_role;
grant select (id, film_id, org_id, n, purpose, film_version, quote_id, status, credit_ref, exempt, confirmed_credits, captured_credits,
              assembly_minutes, assembly_unit_credits, assembly_confirmed_credits, assembly_status, assembly_output_seconds,
              assembly_charged_credits, claimed_at, heartbeat_at, attempts, max_attempts, deadline_at, settle_reason,
              idempotency_key, created_by, created_at, updated_at, settled_at)
  on public.film_segments to authenticated;
grant select (org_id, max_credits_per_film, max_active_films, updated_at) on public.org_film_settings to authenticated;
-- The money of each take is the price the person confirmed (0084: the rate as charged): members read it.
grant select (segment_id, credit_unit, unit_credits, quantity, minimum_credits, confirmed_credits, charged_credits, charge_basis,
              output_seconds)
  on public.film_takes to authenticated;

drop policy if exists film_segments_select on public.film_segments;
create policy film_segments_select on public.film_segments
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists org_film_settings_select on public.org_film_settings;
create policy org_film_settings_select on public.org_film_settings
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

revoke all on function public.film_money_limits() from public, anon, authenticated, service_role;
revoke all on function public.film_settings_of(uuid) from public, anon, authenticated, service_role;
revoke all on function public.film_moderation_billing(text) from public, anon, authenticated, service_role;
revoke all on function public.film_stand_in(uuid) from public, anon, authenticated, service_role;
revoke all on function public.film_model_problem(text, text[], text) from public, anon, authenticated, service_role;
revoke all on function public.film_try_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.film_price(public.films) from public, anon, authenticated, service_role;
revoke all on function public.film_segment_json(public.film_segments) from public, anon, authenticated, service_role;
revoke all on function public.film_take_money_json(public.film_takes) from public, anon, authenticated, service_role;
revoke all on function public.film_settle_locked(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.film_lock_segment(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.film_lock_take(uuid, text) from public, anon, authenticated, service_role;

revoke all on function public.quote_film(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.start_film(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.quote_film(uuid, integer) to authenticated;
grant execute on function public.start_film(uuid, text, text) to authenticated;

revoke all on function public.film_claim_segment(text, interval) from public, anon, authenticated, service_role;
revoke all on function public.film_heartbeat_segment(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.film_begin_take(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.film_take_succeeded(uuid, text, numeric, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.film_take_failed(uuid, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.film_begin_assembly(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.film_record_assembly(uuid, text, boolean, numeric) from public, anon, authenticated, service_role;
revoke all on function public.film_settle_segment(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.film_cancel_segment(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.film_expire_segments() from public, anon, authenticated, service_role;
grant execute on function public.film_claim_segment(text, interval) to service_role;
grant execute on function public.film_heartbeat_segment(uuid, text) to service_role;
grant execute on function public.film_begin_take(uuid, text) to service_role;
grant execute on function public.film_take_succeeded(uuid, text, numeric, uuid, uuid) to service_role;
grant execute on function public.film_take_failed(uuid, text, text, text, text) to service_role;
grant execute on function public.film_begin_assembly(uuid, text) to service_role;
grant execute on function public.film_record_assembly(uuid, text, boolean, numeric) to service_role;
grant execute on function public.film_settle_segment(uuid, text, text) to service_role;
grant execute on function public.film_cancel_segment(uuid, text) to service_role;
grant execute on function public.film_expire_segments() to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.film_price(public.films)', 'd06cf0e0b2bcbcbbb67dec33c1d34e23'),
      ('public.quote_film(uuid, integer)', '62d08b9f018e5fb40a9b2ad3fb215e68'),
      ('public.start_film(uuid, text, text)', '18b1c922a17dfa6ab7c0d950acd90fa3'),
      ('public.film_settle_locked(uuid, uuid, text)', 'a4d7ac1f3137ce51d597802f1697be48'),
      ('public.film_take_succeeded(uuid, text, numeric, uuid, uuid)', 'f3cf4dcd93b4057c54645ca0639942c4'),
      ('public.film_take_failed(uuid, text, text, text, text)', '26bbde0ee9bc86409143d23461645fab')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception '0171 end state: % does not hold this file''s body (md5 %)', r.sig, h;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.quote_film(uuid, integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.start_film(uuid, text, text)', 'execute')
     or has_function_privilege('anon', 'public.start_film(uuid, text, text)', 'execute')
     or has_function_privilege('service_role', 'public.start_film(uuid, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.film_settle_segment(uuid, text, text)', 'execute')
     or not has_function_privilege('service_role', 'public.film_settle_segment(uuid, text, text)', 'execute')
     or has_function_privilege('service_role', 'public.film_price(public.films)', 'execute')
     or has_table_privilege('authenticated', 'public.film_segments', 'select')
     or has_table_privilege('service_role', 'public.film_segments', 'insert')
     or has_table_privilege('authenticated', 'public.org_film_settings', 'insert')
     or has_column_privilege('authenticated', 'public.film_segments', 'request_hash', 'select') then
    raise exception '0171 end state: a grant is not what this file sets';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.films'::regclass and conname = 'films_status_check'
                    and pg_get_constraintdef(oid) like '%''queued''%')
     or not exists (select 1 from pg_constraint where conrelid = 'public.creative_jobs'::regclass
                       and conname = 'creative_jobs_payer_check' and pg_get_constraintdef(oid) like '%''film''%')
     or not exists (select 1 from pg_constraint where conrelid = 'public.creative_jobs'::regclass
                       and conname = 'creative_jobs_film_payer_check')
     or not exists (select 1 from pg_constraint where conrelid = 'public.film_takes'::regclass and conname = 'film_takes_segment_fk') then
    raise exception '0171 end state: a constraint is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.film_segments'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.org_film_settings'::regclass) then
    raise exception '0171 end state: row level security is off';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (read-only, run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   to_regclass('public.film_segments') is not null and to_regclass('public.org_film_settings') is not null       as tables_exist,
--   (select bool_and(c.relrowsecurity) from pg_class c
--     where c.oid in ('public.film_segments'::regclass, 'public.org_film_settings'::regclass))              as rls_on,
--   not exists (select 1 from unnest(array['public.film_segments', 'public.org_film_settings']) t,
--                             unnest(array['anon', 'authenticated', 'service_role']) r,
--                             unnest(array['insert', 'update', 'delete', 'truncate']) p
--                where has_table_privilege(r, t, p))                                                     as no_direct_writes,
--   has_function_privilege('authenticated', 'public.quote_film(uuid, integer)', 'execute')
--     and has_function_privilege('authenticated', 'public.start_film(uuid, text, text)', 'execute')
--     and not has_function_privilege('anon', 'public.quote_film(uuid, integer)', 'execute')
--     and not has_function_privilege('authenticated', 'public.film_claim_segment(text, interval)', 'execute')
--     and has_function_privilege('service_role', 'public.film_claim_segment(text, interval)', 'execute')    as grants_ok,
--   (select pg_get_constraintdef(oid) like '%''queued''%' from pg_constraint
--     where conrelid = 'public.films'::regclass and conname = 'films_status_check')                         as films_can_queue,
--   (select pg_get_constraintdef(oid) like '%''film''%' from pg_constraint
--     where conrelid = 'public.creative_jobs'::regclass and conname = 'creative_jobs_payer_check')          as film_payer_allowed,
--   not exists (select 1 from public.creative_jobs where payer = 'film' and (film_take_id is null or credit_ref is not null)) as film_jobs_hold_nothing,
--   (select bool_and(p.proconfig @> array['search_path=public, pg_temp']) from pg_proc p
--     where p.oid in ('public.quote_film(uuid, integer)'::regprocedure, 'public.start_film(uuid, text, text)'::regprocedure,
--                     'public.film_settle_segment(uuid, text, text)'::regprocedure))                        as search_path_pinned,
--   exists (select 1 from public.credit_prices where unit = 'film_assembly_minute')                         as assembly_priced;
--   -- assembly_priced is false until a platform admin sets the price; until then every quote reads unpriced on the assembly line.
