-- 0215_film_archive_resume.sql — Film Studio: a paused or cancelled project can be put away, and a paused one can go on, paying only
-- for what it has not made yet. Switch-on gate G1 (docs/FILM_STUDIO.md, docs/studio/S2_GAPS.md). And the film worker's id (host
-- name and pid) is kept out of the film's history as members read it (film_read) and out of every claim event written from now on.
-- NOT closed here, open in the security ledger with their own fix: creative_jobs.worker_id, which 0036's table grant lets a member
-- select (BR-0036-01), and detail.worker in film_events / creative_job_events rows written before 0215, readable by a direct select
-- (BR-0036-02). worker_ref is an unsalted md5 (BR-0215-01, info, open).
--
-- EVIDENCE (read from the migrations, not assumed):
--   * 0166's archive_film refuses unless film_is_editable (draft / planned). 0171, 0198 and 0200 do not redefine it. A film that paused
--     (0171's film_settle_locked: something was charged and the segment stopped short) or was cancelled with a charge can neither be
--     put away nor go on: start_film refuses every status but draft / planned (film_not_startable), and save_film the same.
--   * 0171's film_segments.purpose is a closed list of one word ('initial'), its comment reserving "a later migration's resume".
--   * 0198's film_take_job decides a take's input pictures from the takes THIS segment completed (segment_id = the take's segment):
--     a new segment that held only the takes still to make could not find the key frame or last frame an earlier segment made.
--   * 0171's film_claim_segment (and 0198's, line 761) writes segment_claimed with detail.worker = the worker id, which
--     tools/film_worker.py defaults to the host name and the process id; 0166's film_read hands every event's detail to every
--     member (film_json, save_film, archive_film). 0198's claim_creative_job (line 891) writes creative_job_log 'claimed' with the
--     same id. 0198's start_film answers a replay with film_segment_json(s), worker_id included, after the claim.
--
-- WHAT A CANCELLED FILM IS (decided from 0171's code): film_settle_locked leaves a film `cancelled` only when its cancel came after
--   something was charged; a cancel that charged nothing sends the film back to `draft`, where start_film may start it again. So 0171
--   treats a charged cancel as an end: a person stopped it on purpose, and start_film never restarts it. 0215 keeps that: a cancelled
--   film can be archived and is NOT resumable (film_not_resumable). Only `paused` (the run stopped short on its own: a failure, the
--   deadline, the switch) resumes.
--
-- CHANGE (additive; seven bodies replaced, each with marked 0215 hunks and nothing else changed; nine functions added; one check
-- constraint replaced by a superset; three columns and three checks added):
--   archive_film (0166's body)        archives a draft, planned, PAUSED or CANCELLED film (the same roles: editors and above). Refused
--     while any segment of the film is open (queued / running / draining: NS409 segment_open) or a refund waits on one of its holds (an
--     open credit_refund_recoveries row of 0167 that lists it: NS409 refund_pending). Never touches money, takes or results: a paid
--     result stays in the takes and the library. Writes its film_events row as before (from_status, and the pause reason).
--   film_read (0166's body, one hunk) an event's detail reaches a member without `worker`: the rows already written included.
--   film_claim_segment (0198's body, one hunk)  segment_claimed records worker_ref = the first 12 hex of md5(worker id), never the id.
--   claim_creative_job (0198's body, one hunk)  creative_job_log 'claimed' records worker_ref the same way.
--   start_film (0198's body, two hunks)         a replay answers the segment without worker_id; only an owner or admin MEMBER spends
--     (not_a_member, below).
--   quote_film (0198's body, one hunk)          says not_a_member in blocked_by (startable false) to a platform admin who is not one.
--   is_org_spender(org, min_role)        internal, standalone (later spend paths reuse it): the caller holds a seat of at least
--     min_role in org_members, or is a platform owner or admin in the exempt organization, whose credits are the platform's own
--     (the owner's decision, 22 Nov). A platform owner or admin who is not a member reads (quotes take no hold) but never starts,
--     resumes or re-runs a film on an organization's credits (NS400 not_a_member, raised with who may call, before anything is
--     counted).
--   film_settle_locked (0198's body, two hunks) a segment whose assembly is recorded completed settles 'completed' (the film ready),
--     whatever reason reached it (the sweep's deadline, a lost worker); a resume segment that captured 0 and made nothing new (its only
--     completed takes are carried) puts the film back to paused, never `cancelled`, with the earlier pause reason after a cancel.
--   film_segments  + resumed_from (the segment this one continues); purpose may be 'resume' (film_segments_state_check, a superset of
--     0171's); film_segments_resume_check: a resume segment names the segment it continues, and only it does.
--   film_takes     + carried_from_take_id: a take a resume segment CARRIES (the earlier segment completed it) is a copy of that take
--     in the new segment: completed, the same result and last frame, confirmed 0 and charged 0 (charge_basis carried_not_charged),
--     no creative job. film_takes_carried_check says so in the table, so no path can charge a carried take.
--   film_quotes    + purpose ('initial' / 'resume'), from_segment (a resume quote names the segment it continues) and carried (each
--     carried take with its result and last frame, as quoted: the start refuses film_changed when any moved since).
--   film_resume_done(take)               internal: a take of the newest segment is done (completed, its result still live).
--   film_resume_precheck(film, segment)  internal: what a resume would refuse before any pricing.
--   film_resume_price(film)              internal: 0171's film_price at today's rates, kept only for the lines the newest segment did
--                                        not complete (see "THE RESUME" below). No pricing logic of its own.
--   quote_film_resume(film, version)     owners and admins (start_film's caller rules): the resume quote.
--   start_film_resume(film, quote_id, idempotency_key)  owners and admins: the resume start.
--   rerun_film_assembly(film, quote_id, idempotency_key)  owners and admins: a resume whose only line is a failed assembly (every
--                                        take made), with its own refusals (not_assembly_failure, film_changed); then start_film_resume.
--   film_assembly_retryable(word)        internal: the assembly failure words a re-run may cure (S4's list, kept once).
--
-- THE RESUME (docs/FILM_STUDIO.md, "Resume"; contract approved by the coordinator)
--   * What is priced. The film's newest segment (the one that paused it). A line is DONE when that segment has a completed take of it
--     (key frame, clip, extend, narration), or for the assembly when its assembly completed. Every other line (a take that failed for
--     good, was skipped, or never began) is priced again by film_price, today, exactly as quote_film would price it. A carried take
--     is never priced, held or charged again.
--   * Unknown stays unknown (rule 5). A line that cannot be priced makes the total and quote_id NULL, and nothing can start. A line's
--     `original_credits` is what the earlier segment confirmed for it; when one is not known, `original_remaining` is NULL and so are
--     `changed` and `delta`, never 0.
--   * The quote is stored in film_quotes (purpose 'resume', from_segment, 30 minutes) as 'fq-<version>-<md5 of the film, version, the
--     segment it continues, the remaining lines and the total>', so a resume quote never starts an initial segment (start_film's own
--     re-pricing differs) and an initial quote never resumes (purpose).
--   * The start mirrors start_film: who, the adult refusals, the key's and the quote id's shape, the replay (the same key, film and
--     quote answer the first segment; another is idempotency_conflict), the film (paused, else film_not_resumable; a new key on a film
--     that already resumed is refused here), its version, the switch, film_resume_precheck, then COUNTED (db.film.start, the same
--     bucket), then returned refusals: the stored resume quote (price_changed / quote_expired), the stored total against the available
--     credits (insufficient_credits, NS402), cap_exceeded (the whole film's: what its segments captured plus this resume), limit_reached, the re-pricing (a line's own word, price_changed), the rights
--     acknowledgement, reserve_credits' NS402 / NS429 / hold_refused. Then one new segment (n + 1, purpose 'resume') and one new hold
--     fm-<segment id> of the resume total only, the carried takes and the planned takes in it, the film paused -> queued, one `resumed`
--     event. 0171's worker functions drive it unchanged: the carried takes are completed, so the worker skips them, makes the rest and
--     assembles; film_settle_locked captures the new segment's charges (never above its hold), and a resume that made nothing new leaves
--     the film paused again (its carried takes count as made), never back to draft.
--
-- NOT CHANGED: every price, hold, capture and release rule of 0171/0198; film_price, film_precheck, film_take_job and the worker
--   (film_settle_locked only as above: who is charged and what is captured are unchanged). The switch stays as it is (this file never writes film_studio_settings or org_film_settings). There is no publish path here
--   (CLAUDE.md rule 2). The browser routes for archive (`/api/films/{id}/archive` already calls archive_film) and resume are a follow-up.
--
-- REPLACES (md5 drift guard: the earlier body, or this file's own on a replay; whitespace runs read as one space):
--   film_read            92f02292981b366f817bd37881e20a0f (0166) -> 981acaa80ff158976f8b9c70b547b270
--   archive_film         9ca4e793fd81bbd4a0aecdebd59d6dc6 (0166) -> 55c7d0a270fd61f65d6aee32f4af3c67
--   start_film           7971355d754165affaf3e08904b4b078 (0198) -> 4ff45b2145f8cf3e4abab7befacb5971
--   film_claim_segment   40db385bb4e3893e1085ee38dcd6f49b (0198) -> 8f5fc37c0d0a5223e5f53e1a6e62e770
--   claim_creative_job   3ca4da96aabe145b34a0275ed4d1c841 (0198) -> 7a0a6d9b16d1b03a4e99a35e577e8711
--   film_settle_locked   7caa68e2b6698c81e34c4f965950adf9 (0198) -> aed04169cd567e5b9f971412c92b5323
--   quote_film           99d01240ed2df7fb002f674df8891608 (0198) -> ce64d1e3843a163c088943758036fdf8
-- REPLAY. This file replays onto itself. Re-running 0166 or 0198 after it FAILS LOUDLY (their guards refuse these bodies): take this
--   file out first with its rollback. Re-running 0036 or 0171 after it fails or silently replaces claim_creative_job /
--   film_claim_segment the way 0198 describes: take 0198 (and so this file) out first.
--   rollback_0198 and rollback_0166 refuse while this file's bodies are live: take this file out first.
--
-- LOCKS WHILE APPLYING. ALTER TABLE on film_segments, film_takes and film_quotes (a column each with no default: no rewrite; the checks
--   scan their tables once) takes ACCESS EXCLUSIVE on each until commit. `set local lock_timeout = '5s'` makes the file fail instead of
--   queueing behind the film worker (it then applies on a retry).
--
-- NUMBER. Provisionally 0215; the coordinator confirms it at merge. Needs 0166, 0167, 0171, 0187, 0192, 0198.
-- Undo: docs/sql/rollback_0215_film_archive_resume.sql (owner-applied): the seven earlier bodies back, the nine functions dropped; the
--   columns, the superset check and the two record checks are kept (they are the record of what resumed and what was carried).
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).

set local lock_timeout = '5s';

do $$
declare
  r    record;
  h    text;
  d    text;
  lits text[];
begin
  if to_regprocedure('public.film_studio_on_for(uuid)') is null or to_regprocedure('public.film_take_job(uuid, text)') is null
     or to_regclass('public.film_segments') is null then
    raise exception '0215 needs Film Studio P3: apply 0171_films_money.sql and 0198_film_studio_org_switch.sql first';
  end if;
  if to_regprocedure('public.film_adult_refusals(uuid, uuid)') is null
     or to_regprocedure('public.film_acknowledgement_missing(public.films, uuid)') is null then
    raise exception '0215 asks what start_film asks: apply 0187_rights_acknowledgement_inputs.sql and 0192_adult_attestation.sql first';
  end if;
  if to_regclass('public.credit_refund_recoveries') is null then
    raise exception '0215 needs credit_refund_recoveries: apply 0167_refund_hold_recovery.sql first';
  end if;
  -- The seven bodies this file replaces: the earlier one, or this file's own (a replay).
  for r in select * from (values
      ('public.film_read(uuid)', '92f02292981b366f817bd37881e20a0f', '981acaa80ff158976f8b9c70b547b270', '0166'),
      ('public.archive_film(uuid)', '9ca4e793fd81bbd4a0aecdebd59d6dc6', '55c7d0a270fd61f65d6aee32f4af3c67', '0166'),
      ('public.start_film(uuid, text, text)', '7971355d754165affaf3e08904b4b078', '4ff45b2145f8cf3e4abab7befacb5971', '0198'),
      ('public.film_claim_segment(text, interval)', '40db385bb4e3893e1085ee38dcd6f49b', '8f5fc37c0d0a5223e5f53e1a6e62e770', '0198'),
      ('public.claim_creative_job(text, interval)', '3ca4da96aabe145b34a0275ed4d1c841', '7a0a6d9b16d1b03a4e99a35e577e8711', '0198'),
      ('public.film_settle_locked(uuid, uuid, text)', '7caa68e2b6698c81e34c4f965950adf9', 'aed04169cd567e5b9f971412c92b5323', '0198'),
      ('public.quote_film(uuid, integer)', '99d01240ed2df7fb002f674df8891608', 'ce64d1e3843a163c088943758036fdf8', '0198')) v(sig, was, now_, src) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0215 found % with a body that is neither %''s nor 0215''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
  -- The check this file replaces: 0171's (purpose 'initial' only) or this file's ('initial' and 'resume'), compared as its quoted words.
  select pg_get_constraintdef(oid) into d from pg_constraint
   where conrelid = 'public.film_segments'::regclass and conname = 'film_segments_state_check';
  select array_agg(distinct m[1] order by m[1]) into lits from regexp_matches(coalesce(d, ''), '''([^'']*)''', 'g') m;
  if d is null
     or (lits is distinct from (select array_agg(x order by x) from unnest(array['initial', 'queued', 'running', 'draining', 'settled',
           'released', '^[a-z][a-z0-9_]{0,63}$']) x)
         and lits is distinct from (select array_agg(x order by x) from unnest(array['initial', 'resume', 'queued', 'running',
           'draining', 'settled', 'released', '^[a-z][a-z0-9_]{0,63}$']) x))
     or d not like '%max_attempts%' or d not like '%worker_id%' then
    raise exception '0215 found film_segments_state_check that is not 0171''s or this file''s (%): read it first', d;
  end if;
  -- The functions this file creates: absent, or this file's own bodies (a replay).
  for r in select * from (values
      ('public.film_resume_done(public.film_takes)', '74a15de06371eb06e694c7e1ef75d891'),
      ('public.film_assembly_retryable(text)', '82ec51dabd0ff178ec2280bc0c56e62b'),
      ('public.rerun_film_assembly(uuid, text, text)', '077e568b33d99c5e2056a66ca3e22121'),
      ('public.film_resume_precheck(public.films, uuid)', 'aa7275ed5e8520af52cabd03c2f930d8'),
      ('public.film_resume_price(public.films)', 'cb0951bf0db3f3ff4858607eb7d948b0'),
      ('public.quote_film_resume(uuid, integer)', '82168c33540974bd5972f89e4daceaeb'),
      ('public.is_org_spender(uuid, text)', '91b76ea25715c4b6d66b6adbc1f6a885'),
      ('public.start_film_resume(uuid, text, text)', 'b8d3d8099e9788d629ef4f003d659936')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is not null and h <> r.want then
      raise exception '0215 found % with a body that is not this file''s (md5 %): read the live body first', r.sig, h;
    end if;
  end loop;
  -- The columns this file adds: absent, or this file's own.
  for r in select * from (values ('film_segments', 'resumed_from', 'uuid', 'YES', null::text),
                                 ('film_takes', 'carried_from_take_id', 'uuid', 'YES', null),
                                 ('film_quotes', 'from_segment', 'uuid', 'YES', null),
                                 ('film_quotes', 'carried', 'jsonb', 'YES', null),
                                 ('film_quotes', 'purpose', 'text', 'NO', '''initial''::text')) v(t, c, typ, nul, def) loop
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = r.t and column_name = r.c
                  and (data_type <> r.typ or is_nullable <> r.nul or column_default is distinct from r.def)) then
      raise exception '0215 found public.%.% that is not this file''s (% %, default %): read it first', r.t, r.c, r.typ,
        case r.nul when 'NO' then 'not null' else 'null' end, coalesce(r.def, 'none');
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The record of a resume (columns and checks)
-- ───────────────────────────────────────────────────────────────────────────

-- The segment a resume continues. Same film (the composite key 0171 gave film_segments), and each segment is resumed at most once.
alter table public.film_segments add column if not exists resumed_from uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.film_segments'::regclass
                    and conname = 'film_segments_resumed_from_fk') then
    alter table public.film_segments add constraint film_segments_resumed_from_fk
      foreign key (resumed_from, film_id) references public.film_segments (id, film_id) on delete restrict;
  end if;
end $$;
create unique index if not exists film_segments_resumed_from_key on public.film_segments (resumed_from) where resumed_from is not null;

-- 0171's state check with 'resume' added to purpose. Everything else is 0171's.
alter table public.film_segments drop constraint if exists film_segments_state_check;
alter table public.film_segments add constraint film_segments_state_check
  check (n >= 1 and film_version >= 1
         and purpose in ('initial', 'resume')
         and status in ('queued', 'running', 'draining', 'settled', 'released')
         and ((status in ('settled', 'released')) = (settled_at is not null))
         and ((status in ('settled', 'released')) = (captured_credits is not null))
         and (settle_reason is null or settle_reason ~ '^[a-z][a-z0-9_]{0,63}$')
         and (status <> 'queued' or (worker_id is null and claimed_at is null))
         and max_attempts between 1 and 10 and attempts between 0 and max_attempts
         and (worker_id is null or char_length(worker_id) between 1 and 120));
alter table public.film_segments drop constraint if exists film_segments_resume_check;
alter table public.film_segments add constraint film_segments_resume_check
  check ((purpose = 'resume') = (resumed_from is not null) and resumed_from is distinct from id);

comment on column public.film_segments.resumed_from is
  'The segment this one continues (migration 0215): set exactly when purpose = ''resume''. Its completed takes are carried in at 0.';

-- A take a resume segment carries: a copy of the take the earlier segment completed, completed and at 0, never charged again.
alter table public.film_takes add column if not exists carried_from_take_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.film_takes'::regclass and conname = 'film_takes_carried_from_fk') then
    alter table public.film_takes add constraint film_takes_carried_from_fk
      foreign key (carried_from_take_id) references public.film_takes (id) on delete restrict;
  end if;
end $$;
create index if not exists film_takes_carried_from_idx on public.film_takes (carried_from_take_id) where carried_from_take_id is not null;
alter table public.film_takes drop constraint if exists film_takes_carried_check;
alter table public.film_takes add constraint film_takes_carried_check
  check ((carried_from_take_id is not null) = (coalesce(charge_basis, '') = 'carried_not_charged')
         and (carried_from_take_id is null
              or (segment_id is not null and status = 'completed' and confirmed_credits = 0 and charged_credits = 0
                  and creative_job_id is null and carried_from_take_id <> id)));

comment on column public.film_takes.carried_from_take_id is
  'The take an earlier segment completed that this one carries into a resume segment (migration 0215): same result, confirmed 0, charged 0 (charge_basis carried_not_charged). Never granted to a browser: charge_basis says it.';

-- A resume quote names the segment it continues.
alter table public.film_quotes add column if not exists purpose text not null default 'initial';
alter table public.film_quotes add column if not exists from_segment uuid;
-- What a resume quote carries (each take with its result and last frame): the start refuses film_changed if any of it moved since.
alter table public.film_quotes add column if not exists carried jsonb;
alter table public.film_quotes drop constraint if exists film_quotes_purpose_check;
alter table public.film_quotes add constraint film_quotes_purpose_check
  check (purpose in ('initial', 'resume') and ((purpose = 'resume') = (from_segment is not null))
         and (carried is null or (purpose = 'resume' and jsonb_typeof(carried) = 'array' and octet_length(carried::text) <= 65536)));
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.film_quotes'::regclass and conname = 'film_quotes_from_segment_fk') then
    alter table public.film_quotes add constraint film_quotes_from_segment_fk
      foreign key (from_segment, film_id) references public.film_segments (id, film_id) on delete cascade;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Archive: a paused or cancelled film too (0166's body, one marked hunk and its log line)
-- ───────────────────────────────────────────────────────────────────────────

-- Put a draft away, or a film that stopped (paused) or was stopped (cancelled): it keeps its storyboard, its takes and its history,
-- stops counting toward the open-draft limit, and can no longer be edited or resumed. Archiving an archived film again changes
-- nothing and writes nothing.
create or replace function public.archive_film(p_film uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  lim jsonb := public.film_limits();
  org uuid;
  f   public.films;
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
  select * into f from public.films where id = p_film for no key update;
  if f.status = 'archived' then
    return public.film_read(f.id);
  end if;
  -- 0215: a paused or cancelled film may be put away too (switch-on gate G1): a person who paid into a film that stopped short has a
  -- way to put it away. Never while money may still move on it: an open segment (its hold, a worker spending) or a refund that
  -- waits to collect from one of its holds (0167's credit_refund_recoveries). Archiving touches no money and no take: a paid result
  -- stays where it is, in the takes and in the library.
  if not (public.film_is_editable(f.status) or f.status in ('paused', 'cancelled')) then
    perform public.creative_refuse('film_not_editable', format('a %s film cannot be archived', f.status), 'NS409');
  end if;
  if exists (select 1 from public.film_segments g where g.film_id = f.id and g.status in ('queued', 'running', 'draining')) then
    perform public.creative_refuse('segment_open',
      'this film is still running or settling; wait until it has stopped, then archive it', 'NS409');
  end if;
  if exists (select 1 from public.credit_refund_recoveries r
               join public.film_segments g on g.org_id = r.org_id and g.credit_ref = any (r.holds)
              where g.film_id = f.id and r.collected + r.lapsed < r.owed) then
    perform public.creative_refuse('refund_pending',
      'a refund is still being collected from this film''s credits; archive it once that is settled', 'NS409');
  end if;
  perform public.film_take_rate('archive', (lim ->> 'archives_per_hour')::integer);
  update public.films
     set status = 'archived', archived_at = now(), version = version + 1, updated_at = now()
   where id = f.id;
  perform public.film_log(f.id, f.org_id, null, 'archived', jsonb_build_object('from_status', f.status)
    -- 0215: why a paused film had stopped stays in its record.
    || case when f.pause_reason is not null then jsonb_build_object('pause_reason', f.pause_reason) else '{}'::jsonb end);
  return public.film_read(f.id);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The film's history as a member reads it (0166's film_read, one marked hunk)
-- ───────────────────────────────────────────────────────────────────────────

-- The film as the app shows it (0166's comment): film_json, save_film, archive_film and create_film_draft answer with it.
create or replace function public.film_read(p_film uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'film', jsonb_build_object(
      'id', f.id, 'org_id', f.org_id, 'channel_id', f.channel_id, 'title', f.title, 'source_kind', f.source_kind,
      'source_text', f.source_text, 'language', f.language, 'aspect', f.aspect, 'target_seconds', f.target_seconds,
      'resolution', f.resolution, 'style_kit_id', f.style_kit_id, 'keyframe_model', f.keyframe_model,
      'clip_model', f.clip_model, 'voice', f.voice, 'music_asset_id', f.music_asset_id, 'music_gain_db', f.music_gain_db,
      'duck_db', f.duck_db, 'captions_mode', f.captions_mode, 'transition_default', f.transition_default,
      'status', f.status, 'pause_reason', f.pause_reason, 'pause_detail', f.pause_detail, 'version', f.version,
      'idempotency_key', f.idempotency_key, 'created_by', f.created_by, 'created_at', f.created_at,
      'updated_at', f.updated_at, 'archived_at', f.archived_at),
    'editable', public.film_is_editable(f.status),
    'style_kit_missing', f.style_kit_id is not null
                         and not exists (select 1 from public.style_kits k where k.id = f.style_kit_id and k.org_id = f.org_id),
    'music_missing', f.music_asset_id is not null and not public.film_asset_live(f.org_id, f.music_asset_id, 'audio'),
    'totals', jsonb_build_object(
      'scenes', (select count(*) from public.film_scenes s where s.film_id = f.id),
      'planned_seconds', (select coalesce(sum(s.planned_seconds), 0) from public.film_scenes s where s.film_id = f.id)),
    'refs', coalesce((select jsonb_agg(public.film_ref_json(r) order by r.position)
                        from public.film_refs r where r.film_id = f.id and r.scene_id is null), '[]'::jsonb),
    'scenes', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', s.id, 'position', s.position, 'title', s.title, 'narration', s.narration,
                          'visual_prompt', s.visual_prompt, 'negative_prompt', s.negative_prompt,
                          'planned_seconds', s.planned_seconds, 'shot_count', s.shot_count,
                          'first_frame', s.first_frame, 'first_frame_asset_id', s.first_frame_asset_id,
                          'last_frame', s.last_frame, 'last_frame_asset_id', s.last_frame_asset_id,
                          'keyframe_model', s.keyframe_model, 'clip_model', s.clip_model, 'clip_params', s.clip_params,
                          'transition_in', s.transition_in, 'current_version', s.current_version, 'status', s.status,
                          'created_at', s.created_at, 'updated_at', s.updated_at,
                          'first_frame_missing', s.first_frame_asset_id is not null
                                                 and not public.film_asset_live(s.org_id, s.first_frame_asset_id, 'image'),
                          'last_frame_missing', s.last_frame_asset_id is not null
                                                and not public.film_asset_live(s.org_id, s.last_frame_asset_id, 'image'),
                          'refs', coalesce((select jsonb_agg(public.film_ref_json(r) order by r.position)
                                              from public.film_refs r where r.film_id = f.id and r.scene_id = s.id), '[]'::jsonb),
                          'takes', coalesce((select jsonb_agg(public.film_take_json(t) order by t.version, t.shot_index, t.attempt)
                                               from public.film_takes t where t.film_id = f.id and t.scene_id = s.id), '[]'::jsonb))
                          order by s.position)
                          from public.film_scenes s where s.film_id = f.id), '[]'::jsonb),
    'takes', coalesce((select jsonb_agg(public.film_take_json(t) order by t.kind, t.version, t.attempt)
                         from public.film_takes t where t.film_id = f.id and t.scene_id is null), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', e.id, 'event', e.event, 'scene_id', e.scene_id, 'actor', e.actor, 'actor_role', e.actor_role,
                          -- 0215: never the worker's id (the host name and process id by default), which 0171's and 0198's
                          -- segment_claimed wrote as detail.worker: the rows already written are read without it too.
                          'detail', e.detail - 'worker', 'created_at', e.created_at) order by e.id desc)
                          from (select * from public.film_events e where e.film_id = f.id order by e.id desc limit 50) e),
                       '[]'::jsonb),
    'events_total', (select count(*) from public.film_events e where e.film_id = f.id),
    'events_truncated', (select count(*) > 50 from public.film_events e where e.film_id = f.id),
    'limits', public.film_limits())
  from public.films f where f.id = p_film
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The worker's id stays out of what members read (0198's bodies, one marked hunk each)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.film_claim_segment(p_worker text, p_stale_after interval default interval '10 minutes')
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w    text := left(btrim(coalesce(p_worker, '')), 120);
  c    record;
  s    public.film_segments;
  lim  jsonb := public.film_money_limits();
  st   text;
  msg  text;
begin
  if w = '' then
    raise exception 'film_claim_segment: p_worker is required' using errcode = '22023';
  end if;
  if p_stale_after is null or p_stale_after < interval '1 minute' then
    raise exception 'film_claim_segment: p_stale_after must be at least a minute' using errcode = '22023';
  end if;
  for c in select x.id, x.film_id, x.org_id from public.film_segments x
            where x.status = 'queued'
               or (x.status in ('running', 'draining') and (x.heartbeat_at is null or x.heartbeat_at < now() - p_stale_after))
            order by x.created_at, x.id loop
    st := null;
    -- 0198: a QUEUED segment of an organization whose Film Studio is off (or with the platform's switch off) is never handed out:
    -- nothing of it has begun, and film_expire_segments settles it at 0. A running or draining one may still be re-claimed, so a
    -- task already at the vendor is polled (film_begin_take and film_take_job let nothing new begin while it is off).
    if not public.film_studio_on_for(c.org_id)
       and exists (select 1 from public.film_segments x where x.id = c.id and x.status = 'queued') then
      continue;
    end if;
    begin
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
      elsif s.attempts >= s.max_attempts then
        -- Every lease is used and the last worker went quiet: end what it left in flight, and settle with what was made.
        perform public.film_lose_inflight_locked(s.id);
        perform public.film_settle_locked(s.film_id, s.id, 'worker_lost');
        continue;
      end if;
      update public.film_segments
         set worker_id = w, heartbeat_at = now(), attempts = attempts + 1, updated_at = now()
       where id = s.id
      returning * into s;
      -- 0198: the lease takes the live jobs of the segment's running takes with it. 0036's calls check only a job's worker id,
      -- so a job left the old worker's would still obey the worker that lost the lease. Segment, then job: film_take_job's order.
      update public.creative_jobs
         set worker_id = w, heartbeat_at = now(), updated_at = now()
       where film_take_id in (select t.id from public.film_takes t where t.segment_id = s.id and t.status = 'running')
         and status in ('running', 'provider_pending', 'processing', 'rendering');
      -- 0215: an opaque reference to the worker, never its id: the id defaults to the host name and the process id
      -- (tools/film_worker.py), and every member of the organization reads this event. The same worker gives the same reference.
      perform public.film_log(s.film_id, s.org_id, null, 'segment_claimed',
                              jsonb_build_object('segment_id', s.id, 'worker_ref', left(md5(w), 12), 'attempt', s.attempts,
                                                 'status', s.status));
      return public.film_segment_json(s) || jsonb_build_object(
        'takes_list', coalesce((select jsonb_agg(public.film_take_money_json(t) order by t.scene_id nulls last, t.shot_index, t.attempt)
                                  from public.film_takes t where t.segment_id = s.id), '[]'::jsonb));
    exception when others then
      -- One segment that cannot be claimed never takes the claim down for every other film.
      st := sqlstate;
      msg := sqlerrm;
      raise warning 'film_claim_segment: segment % skipped (%: %)', c.id, st, msg;
    end;
    -- Written after the block, whose writes were rolled back with it, so the record survives.
    if st is not null then
      perform public.film_record_skip(c.film_id, c.org_id, c.id, 'claim', st, msg);
    end if;
  end loop;
  return null;
end
$$;

create or replace function public.claim_creative_job(
  p_worker text, p_stale_after interval default interval '10 minutes'
) returns setof public.creative_jobs
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  c record;
  s record;
  v_id uuid;
  w text := left(btrim(coalesce(p_worker, '')), 120);
begin
  if not public.credits_trusted_caller() then
    raise exception 'creative jobs are claimed by the platform''s worker only' using errcode = '42501';
  end if;
  if w = '' then
    raise exception 'p_worker is required' using errcode = '22023';
  end if;

  for c in
    select id, org_id from public.creative_jobs
     where status in ('running', 'provider_pending', 'processing', 'rendering')
       and coalesce(heartbeat_at, started_at, created_at) < now() - p_stale_after
       -- 0198: a film take's job (payer 'film') lives by its segment's lease, not by this job heartbeat: never swept here.
       and payer <> 'film'
     order by org_id, id
  loop
    -- Account first, then the job, re-checked under its lock (a heartbeat
    -- may have arrived since the scan).
    perform public.credit_account_lock(c.org_id);
    select id, attempts, max_attempts, provider_task_id, submit_started_at into s
      from public.creative_jobs
     where id = c.id
       and status in ('running', 'provider_pending', 'processing', 'rendering')
       and coalesce(heartbeat_at, started_at, created_at) < now() - p_stale_after
       and payer <> 'film'  -- 0198: as in the scan above
     for update skip locked;
    if not found then
      continue;
    end if;
    if s.submit_started_at is not null and s.provider_task_id is null then
      perform public.creative_end_locked(s.id, 'failed', 'submit_interrupted',
        'the worker stopped while submitting to the provider; it is never submitted twice, and the credits were released');
    elsif s.attempts >= s.max_attempts then
      perform public.creative_end_locked(s.id, 'failed', 'worker_lost',
        format('worker lost (no heartbeat) on the last of %s attempts; the credits were released', s.max_attempts));
    else
      update public.creative_jobs
         set status = 'queued', worker_id = null, updated_at = now()
       where id = s.id;
      perform public.creative_job_log(s.id, c.org_id,
        'requeued', 'queued', jsonb_build_object('reason', 'no heartbeat'));
    end if;
  end loop;

  perform public.creative_expire_locked(null);

  select q.id into v_id
    from public.creative_jobs q
   where q.status = 'queued'
     -- 0198: a film take's job is the film worker's (film_take_job takes a handed-back one back), never a credit worker's.
     and q.payer <> 'film'
   order by (q.provider_task_id is null), q.created_at, q.id
   for update skip locked
   limit 1;
  if v_id is null then
    return;
  end if;

  return query
    update public.creative_jobs j
       set status = case when j.provider_task_id is not null then 'provider_pending' else 'running' end,
           worker_id = w, attempts = j.attempts + 1,
           started_at = coalesce(j.started_at, now()), heartbeat_at = now(), updated_at = now()
     where j.id = v_id
    returning j.*;
  perform public.creative_job_log(v_id, (select org_id from public.creative_jobs where id = v_id),
    'claimed', (select status from public.creative_jobs where id = v_id),
    -- 0215: an opaque reference to the worker, never its id (host name and process id by default), as film_claim_segment records it.
    jsonb_build_object('worker_ref', left(md5(w), 12)));
end
$$;

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
  w       text;
  d       text;
  msg     text;
  fq      public.film_quotes;
  lim     jsonb := public.film_money_limits();
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
  -- 0215 (the owner's decision, 22 Nov): spending an organization's credits takes a seat in it. 0043's accessible_org_ids makes a
  -- platform owner or admin an admin of every organization; that stays read-only support access, and only an owner or admin
  -- MEMBER (org_members) holds the organization's credits. In the exempt organization the credits are the platform's own, so its
  -- platform owner or admin may, as before. Who may call is refused before anything is counted.
  if not public.is_org_spender(org, 'admin') then
    perform public.creative_refuse('not_a_member',
      'you are not an owner or admin member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
  end if;
  -- 0192: the quote's adult refusals again, first of all once the caller is known to be the organization's admin: before the key and
  -- the quote are read, a replay is answered, the start is counted, anything is priced, held or written. A person who said they
  -- are under 18 starts nothing; a model of the film that is for adults only needs an adult attestation first.
  bad := public.film_adult_refusals(p_film, uid) -> 0;
  if bad is not null then
    perform public.creative_refuse(bad ->> 'reason', bad ->> 'detail');
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
    -- 0215: the segment as a member may read it: never the worker's id (the host name and process id by default), which 0171's
    -- column grant withholds and a replay after the claim would otherwise hand back.
    return (public.film_segment_json(s) - 'worker_id') || jsonb_build_object('ok', true, 'replayed', true);
  end if;

  -- The cheap refusals, before anything is counted or priced.
  select * into f from public.films where id = p_film for no key update;
  if not public.film_is_editable(f.status) then
    perform public.creative_refuse('film_not_startable', format('a %s film cannot be started', f.status), 'NS409');
  end if;
  if split_part(p_quote_id, '-', 2)::integer <> f.version then
    perform public.creative_refuse('film_changed',
      format('the film was edited after this quote (it is at version %s); quote it again', f.version), 'NS409');
  end if;
  -- 0198: the platform's switch AND this organization's own (org_film_settings.film_studio_enabled, default off).
  if not public.film_studio_on_for(org) then
    perform public.creative_refuse('film_studio_disabled', 'Film Studio is not switched on yet; nothing was held', 'NS409');
  end if;
  -- Cheap checks of what pricing would refuse (a model off sale or turned Seedance, a reference or frame that is gone): raised with
  -- the line's own word, before anything is counted or priced.
  bad := public.film_precheck(f);
  if bad is not null then
    perform public.creative_refuse(bad ->> 'reason', bad ->> 'detail');
  end if;
  perform public.film_take_rate('start', (lim ->> 'starts_per_hour')::integer);

  -- Counted: from here every refusal is returned, so the counter commits with it. The stored quote first (no pricing yet).
  select * into fq from public.film_quotes x where x.film_id = f.id and x.quote_id = p_quote_id and x.version = f.version;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'price_changed', 'code', 'NS409',
                              'detail', 'this is not a quote of the film as it stands; quote it again');
  end if;
  if fq.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'quote_expired', 'code', 'NS409',
                              'detail', 'this quote has expired; quote it again');
  end if;
  st := public.film_settings_of(org);
  if not exempt_ and fq.total > public.film_available(org) then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_credits', 'code', 'NS402',
                              'detail', format('available=%s needed=%s', public.film_available(org), fq.total));
  end if;
  if st ->> 'max_credits_per_film' is not null and fq.total > (st ->> 'max_credits_per_film')::numeric then
    return jsonb_build_object('ok', false, 'reason', 'cap_exceeded', 'code', 'NS400',
      'detail', format('this film costs %s credits and the organization allows %s a film', fq.total, st ->> 'max_credits_per_film'));
  end if;
  if (select count(*) from public.film_segments x where x.org_id = org and x.status in ('queued', 'running', 'draining'))
     >= (st ->> 'max_active_films')::integer then
    return jsonb_build_object('ok', false, 'reason', 'limit_reached', 'code', 'NS400',
      'detail', format('at most %s films of this organization run at once; wait for one to finish', st ->> 'max_active_films'));
  end if;

  -- Then the re-pricing, at today's rates: what was confirmed is what is held, in either direction.
  q := public.film_price(f);
  if not (q ->> 'priced')::boolean then
    bad := q -> 'refusals' -> 0;
    return jsonb_build_object('ok', false, 'reason', bad ->> 'reason', 'code', 'NS400', 'detail', bad ->> 'detail');
  end if;
  total := (q ->> 'total')::numeric;
  if q ->> 'quote_id' <> p_quote_id then
    return jsonb_build_object('ok', false, 'reason', 'price_changed', 'code', 'NS409',
                              'detail', format('the price is now %s credits; quote it again', total));
  end if;
  -- 0187: a film sends the person's own files to its models too (a clip's uploaded first or last frame; a key frame's
  -- reference pictures, @characters and style kit). A model that requires a rights acknowledgement refuses here, after the
  -- price (a line refused anyway never asks) and before the hold and every take, unless THIS person (the one starting the
  -- film, who pays for it) acknowledged each such file at the CURRENT text version. The takes' jobs are written later by the
  -- worker, never through create_creative_job, so this is the only place a film asks.
  bad := public.film_acknowledgement_missing(f, uid);
  if bad is not null then
    return jsonb_build_object('ok', false, 'reason', 'acknowledgement_required', 'code', 'NS400',
      'detail', format('kind=%s version=%s subject=%s', bad ->> 'kind', coalesce(bad ->> 'text_version', 'none'), bad ->> 'subject'));
  end if;

  -- The hold: 0020's reserve_credits in the admin's own session, before anything is created. Its two refusals (NS402 with available
  -- and needed; NS429 when the plan's parallel runs are in use) are returned with their codes. Nothing is held in the exempt
  -- organization or for a total of 0.
  ref := 'fm-' || replace(sid::text, '-', '');
  if exempt_ or total = 0 then
    ref := null;
  else
    begin
      perform public.reserve_credits(org, ref, total);
    exception when sqlstate 'NS402' or sqlstate 'NS429' or sqlstate '22023' or sqlstate '23505' then
      get stacked diagnostics w = returned_sqlstate, d = pg_exception_detail, msg = message_text;
      if w in ('22023', '23505') then
        -- Not a customer's state (credits, slots) but a refusal of the hold itself: recorded, so someone looks at it.
        perform public.film_log(f.id, org, null, 'start_refused',
          jsonb_build_object('reason', 'hold_refused', 'code', w, 'quote_id', p_quote_id, 'credits', total,
                             'message', left(coalesce(nullif(d, ''), msg), 200)));
      end if;
      return jsonb_build_object('ok', false,
                                'reason', case w when 'NS402' then 'insufficient_credits' when 'NS429' then 'run_slots_full'
                                                 else 'hold_refused' end,
                                'code', w, 'detail', coalesce(nullif(d, ''), msg));
    end;
  end if;

  select l into asm from jsonb_array_elements(q -> 'lines') l where l ->> 'line' = 'assembly';
  insert into public.film_segments (id, film_id, org_id, n, purpose, film_version, quote_id, status, credit_ref, exempt,
                                    confirmed_credits, assembly_minutes, assembly_unit_credits, assembly_confirmed_credits,
                                    max_attempts, idempotency_key, request_hash, created_by)
  values (sid, f.id, org, coalesce((select max(x.n) from public.film_segments x where x.film_id = f.id), 0) + 1, 'initial',
          f.version, p_quote_id, 'queued', ref, exempt_, total, (asm ->> 'quantity')::integer,
          (asm ->> 'credits_per_unit')::numeric, (asm ->> 'credits')::numeric,
          (lim ->> 'max_attempts')::integer, p_idempotency_key, hash, uid)
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
  return public.film_segment_json(s) || jsonb_build_object('ok', true, 'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4b. Settling a resume or a made film (0198's film_settle_locked, two marked hunks)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.film_settle_locked(p_film uuid, p_segment uuid, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s       public.film_segments;
  why     text;
  owed    numeric;
  got     numeric := 0;
  status_ text;
  ran     boolean;
  removed uuid[] := '{}';
begin
  select * into s from public.film_segments where id = p_segment and film_id = p_film;
  if s.status in ('settled', 'released') then
    return public.film_segment_json(s);
  end if;
  why := coalesce(s.settle_reason, p_reason);
  -- 0198: a settled segment leaves no live take job behind (a completed take whose job was never finished, say): each is
  -- ended now, so nothing can be sent or completed for a film whose money is settled.
  perform public.creative_end_locked(j.id, 'failed', 'segment_settled', 'the film''s segment was settled')
     from public.creative_jobs j
    where j.film_take_id in (select x.id from public.film_takes x where x.segment_id = s.id)
      and j.status in ('queued', 'running', 'provider_pending', 'processing', 'rendering');
  update public.film_takes
     set status = 'skipped', charged_credits = 0, charge_basis = 'not_started', updated_at = now(), finished_at = now()
   where segment_id = s.id and status in ('planned', 'queued');
  if s.assembly_status = 'planned' then
    update public.film_segments set assembly_status = 'skipped', assembly_charged_credits = 0 where id = s.id;
  end if;
  select * into s from public.film_segments where id = s.id;
  -- 0215: an assembly recorded completed is a made film, whatever settles the segment (the sweep's deadline, a lost worker, a
  -- cancel that came after it): every take was completed before the assembly could begin, so the film is ready, never paused with
  -- nothing left to resume.
  if s.assembly_status = 'completed' then
    why := 'completed';
  end if;
  owed := (select coalesce(sum(t.charged_credits), 0) from public.film_takes t where t.segment_id = s.id)
          + coalesce(s.assembly_charged_credits, 0);
  if owed > s.confirmed_credits then
    raise exception 'film_settle_locked: charges % exceed the confirmed % of segment %', owed, s.confirmed_credits, s.id;
  end if;
  ran := owed > 0 or s.assembly_status = 'completed'
         or exists (select 1 from public.film_takes t where t.segment_id = s.id and t.status = 'completed');
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
  if not ran then
    -- Nothing was charged and nothing was made: the film goes back to its storyboard, editable and startable again. The takes that
    -- never began (skipped, all at 0) go, so 0166's save_film can delete their scenes; one a creative job names stays (that job's
    -- record). The started and segment_settled events keep what happened.
    with d as (
      delete from public.film_takes t
       where t.segment_id = s.id and t.status = 'skipped' and t.creative_job_id is null
         and not exists (select 1 from public.creative_jobs j where j.film_take_id = t.id)
      returning t.id)
    select coalesce(array_agg(d.id order by d.id), '{}'::uuid[]) into removed from d;
    update public.films
       set status = 'draft', pause_reason = case when why = 'cancelled' then null else why end, pause_detail = null,
           updated_at = now()
     where id = p_film;
  elsif s.resumed_from is not null and owed = 0 and s.assembly_status <> 'completed'
        and not exists (select 1 from public.film_takes t
                         where t.segment_id = s.id and t.status = 'completed' and t.carried_from_take_id is null) then
    -- 0215: a resume that made nothing NEW (its only completed takes are the carried ones) is not a charged cancel: the film goes
    -- back to paused, resumable again, never to `cancelled` with its paid takes stranded. A cancel keeps the earlier pause reason
    -- (the segment it continued settled with it); any other reason says why this resume stopped.
    update public.films
       set status = 'paused',
           pause_reason = case when why = 'cancelled'
                               then (select g.settle_reason from public.film_segments g where g.id = s.resumed_from) else why end,
           pause_detail = null, updated_at = now()
     where id = p_film;
  else
    update public.films
       set status = case when why = 'completed' then 'ready' when why = 'cancelled' then 'cancelled' else 'paused' end,
           pause_reason = case when why in ('completed', 'cancelled') then null else why end,
           pause_detail = null, updated_at = now()
     where id = p_film;
  end if;
  perform public.film_log(p_film, s.org_id, null, 'segment_settled',
    jsonb_build_object('segment_id', s.id, 'reason', why, 'confirmed', s.confirmed_credits, 'charged', owed, 'captured', got,
                       'exempt', s.exempt, 'back_to_draft', not ran, 'takes_removed', cardinality(removed),
                       'removed_take_ids', to_jsonb(removed))
    || case when s.credit_ref is not null and got < owed then jsonb_build_object('not_captured', owed - got) else '{}'::jsonb end);
  return public.film_segment_json(s);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4c. The quote says who may spend (0198's quote_film, one marked hunk)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.quote_film(p_film uuid, p_version integer) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  org      uuid;
  f        public.films;
  q        jsonb;
  st       jsonb;
  avail    numeric;
  active   integer;
  slots    jsonb;
  blocked  jsonb := '[]'::jsonb;
  exempt_  boolean;
  may      boolean;
  on_      boolean;
  lim      jsonb := public.film_money_limits();
  adult_   jsonb;  -- 0192: the film's adult refusals
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
  perform public.film_take_rate('quote', (lim ->> 'quotes_per_hour')::integer);
  q := public.film_price(f);
  -- 0192: someone who said they are under 18 is refused the whole film (adult_only_service), and each model of the film whose
  -- vendor's terms are 18+ (spec.requires_adult) is refused, by name, to anyone without an adult attestation
  -- (adult_attestation_required). Said here, in the quote the person reads before Start (rule 6), and such a quote is not one that
  -- can be started: unpriced, no quote_id, so nothing is stored for start_film to accept.
  adult_ := public.film_adult_refusals(f.id, auth.uid());
  if jsonb_array_length(adult_) > 0 then
    q := q || jsonb_build_object('priced', false, 'total', null, 'quote_id', null,
                                 'refusals', coalesce(q -> 'refusals', '[]'::jsonb) || adult_);
  end if;
  if (q ->> 'priced')::boolean then
    insert into public.film_quotes (film_id, org_id, version, quote_id, total, created_by, expires_at)
    values (f.id, org, f.version, q ->> 'quote_id', (q ->> 'total')::numeric, auth.uid(),
            now() + make_interval(mins => (lim ->> 'quote_minutes')::integer))
    on conflict (film_id, quote_id) do update set expires_at = excluded.expires_at, total = excluded.total;
  end if;
  delete from public.film_quotes where film_id = f.id and (version <> f.version or expires_at <= now());

  exempt_ := public.credits_exempt(org);
  -- 0198: the platform's switch AND this organization's own (org_film_settings.film_studio_enabled, default off), the same
  -- answer start_film gives, so the quote never reads startable for a start that refuses film_studio_disabled.
  on_ := public.film_studio_on_for(org);
  st := public.film_settings_of(org);
  avail := public.film_available(org);
  active := (select count(*) from public.film_segments s where s.org_id = org and s.status in ('queued', 'running', 'draining'));
  slots := public.org_run_slots(org);
  if not on_ then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'film_studio_disabled'));
  end if;
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
  -- 0215: a quote takes no hold, so support may read it; it says before the press that only a member may start it.
  if may and not public.is_org_spender(org, 'admin') then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'not_a_member'));
    may := false;
  end if;
  return q || jsonb_build_object(
    'exempt', exempt_, 'available', avail, 'settings', st, 'active_films', active, 'film_studio_enabled', on_,
    -- 0034 counts the film's hold as one of the plan's parallel runs for as long as it is open: the app warns before Start.
    'run_slot', jsonb_build_object('uses_run_slot', not exempt_, 'slots', slots,
                                   'max_hours', (lim ->> 'unclaimed_hours')::integer + (lim ->> 'deadline_hours')::integer
                                                + (lim ->> 'grace_hours')::integer),
    'quote_expires_at', (select x.expires_at from public.film_quotes x where x.film_id = f.id and x.quote_id = q ->> 'quote_id'),
    'blocked_by', blocked, 'may_start', may,
    'startable', (q ->> 'priced')::boolean and jsonb_array_length(blocked) = 0 and may,
    'limits', lim);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Resume (owners and admins; the helpers are internal)
-- ───────────────────────────────────────────────────────────────────────────

-- 0215 (the owner's decision, 22 Nov): may the caller spend this organization's credits? Only with a seat in it (org_members) of at
-- least p_min_role, never through 0043's accessible_org_ids alone, which makes a platform owner or admin an admin of every
-- organization (that stays read-only support access). The one exception is the exempt organization, whose credits are the
-- platform's own: there a platform owner or admin may, as 0020 and 0171 have it. Standalone on purpose: every spend path asks the
-- same question (here start_film, start_film_resume and rerun_film_assembly; the quotes say it in blocked_by).
create or replace function public.is_org_spender(p_org uuid, p_min_role text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and p_org is not null and p_min_role in ('owner', 'admin', 'editor', 'viewer')
         and (exists (select 1 from public.org_members m
                       where m.org_id = p_org and m.user_id = auth.uid()
                         and public.app_role_rank(m.role) >= public.app_role_rank(p_min_role))
              or (public.credits_exempt(p_org) and public.is_platform_admin()))
$$;

-- Which assembly failures a re-run may cure: S4's retryable words, kept here once, so a test can compare this list with S4's
-- published table. A crash, a render that failed, timed out or degraded, a store or disk problem, an output that did not match,
-- captions that failed or were not there: the same takes may assemble next time. Every other word (a film_timeline refusal such as
-- missing_take or continuity_broken, a review copy too large or missing, narration_missing, film_unavailable, assembly_not_enabled)
-- names something a re-run of the same takes cannot change. Three settle reasons are not the assembly's word at all (below).
-- Callers ask it only of a segment whose assembly is recorded failed.
create or replace function public.film_assembly_retryable(p_word text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_word in ('assembly_crashed', 'render_failed', 'render_timed_out', 'render_degraded', 'store_failed', 'disk_low',
                             'output_mismatch', 'captions_failed', 'captions_unavailable'), false)
         -- The word was lost: the assembly's own word never reached the settle, because the sweep settled the segment at its
         -- deadline, the claim after the last lease settled it worker_lost, or the worker settled the generic assembly_failed (it
         -- raised, or could not begin). The cause is unknown, never proven deterministic, and a failed assembly is charged 0: the
         -- re-run, which costs only the assembly line, is allowed.
         or coalesce(p_word in ('deadline', 'worker_lost', 'assembly_failed'), false)
$$;

-- Whether a take of the film's newest segment is DONE for a resume: completed, and its result (and its extracted last frame, when it
-- has one) still a live file of the library. A result a person deleted since is not carried: that line is priced and made again, so
-- the next take never starts from a picture that is gone and the cut never names a missing file. One definition, read by the
-- precheck and the price alike.
create or replace function public.film_resume_done(t public.film_takes) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select t.status = 'completed'
         and public.film_asset_live(t.org_id, t.result_asset_id,
                                    case t.kind when 'keyframe' then 'image' when 'narration' then 'audio' else 'video' end)
         and (t.result_last_frame_asset_id is null or public.film_asset_live(t.org_id, t.result_last_frame_asset_id, 'image'))
$$;

-- What a resume would refuse that can be seen cheaply, before anything is counted or priced, as {reason, detail} or NULL. The lines
-- still to make are the slots of p_segment (the film's newest) with no done take (film_resume_done), and the assembly when it did
-- not complete:
--   nothing_to_resume   the film never ran (no segment), or every take and the assembly are made;
--   a model's word      a model a remaining line needs is off sale for its role now, or is Seedance (0166's film_check_model, through
--                       0171's film_model_problem); a model only a carried take used is not asked: nothing is sent to it again;
--   reference_missing   a key frame is still to make and a reference picture or character is gone;
--   asset_not_usable    a clip of a scene is still to make and that scene's own first or last picture is gone.
create or replace function public.film_resume_precheck(p_film public.films, p_segment uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  mm  record;
  bad jsonb;
begin
  if p_segment is null then
    return jsonb_build_object('reason', 'nothing_to_resume', 'detail', 'this film has never run; start it instead');
  end if;
  if not exists (select 1 from public.film_takes t where t.segment_id = p_segment
                  group by t.kind, t.scene_id, t.shot_index having not bool_or(public.film_resume_done(t)))
     and exists (select 1 from public.film_segments g where g.id = p_segment and g.assembly_status = 'completed') then
    return jsonb_build_object('reason', 'nothing_to_resume', 'detail', 'every take and the assembly of this film are made');
  end if;
  for mm in select distinct x.model, x.caps, x.field from (
             select min(t.model) as model,
                    case t.kind when 'keyframe' then array['t2i', 'edit'] when 'narration' then array['tts'] else array['i2v'] end as caps,
                    case t.kind when 'keyframe' then 'keyframe_model' when 'narration' then 'voice.model' else 'clip_model' end as field
               from public.film_takes t where t.segment_id = p_segment
              group by t.kind, t.scene_id, t.shot_index having not bool_or(public.film_resume_done(t))) x
            where x.model is not null order by x.field, x.model loop
    bad := public.film_model_problem(mm.model, mm.caps, mm.field);
    if bad is not null then
      return bad - 'priced';
    end if;
  end loop;
  if exists (select 1 from public.film_takes t where t.segment_id = p_segment and t.kind = 'keyframe'
              group by t.scene_id having not bool_or(public.film_resume_done(t)))
     and exists (select 1 from public.film_refs r where r.film_id = p_film.id
                    and ((r.character_id is not null
                          and not exists (select 1 from public.characters c where c.id = r.character_id and c.org_id = r.org_id))
                         or (r.asset_id is not null and not public.film_asset_live(r.org_id, r.asset_id, 'image')))) then
    return jsonb_build_object('reason', 'reference_missing',
                              'detail', 'a reference picture or character no longer exists; the key frames still to make need it');
  end if;
  if exists (select 1 from public.film_scenes s
              where s.film_id = p_film.id
                and ((s.first_frame = 'asset' and not public.film_asset_live(s.org_id, s.first_frame_asset_id, 'image'))
                     or (s.last_frame = 'asset' and not public.film_asset_live(s.org_id, s.last_frame_asset_id, 'image')))
                and exists (select 1 from public.film_takes t where t.segment_id = p_segment and t.scene_id = s.id
                               and t.kind in ('clip', 'extend')
                             group by t.shot_index having not bool_or(public.film_resume_done(t)))) then
    return jsonb_build_object('reason', 'asset_not_usable',
                              'detail', 'a scene still to shoot starts or ends on a picture that is no longer in the library');
  end if;
  return null;
end
$$;

-- The price of what is left of a paused film, at today's rates. 0171's film_price prices the film as it stands, exactly as quote_film
-- would; this keeps only the lines the film's newest segment did not complete (film_resume_done) and drops the rest as CARRIED (its
-- completed take goes into the next segment at 0). No pricing logic of its own: every number is film_price's. Each remaining line also says what the
-- earlier segment confirmed for it (`original_credits`, its first attempt's line: a retry keeps it), and how today's price differs
-- (`delta`, `changed`); an unknown on either side stays NULL (rule 5). A refusal of film_price is kept when it concerns what is left:
-- a remaining line's own, a scene picture of a scene whose clip is left, a reference while a key frame is left, and the film's own.
-- NULL when the film has no segment. Reads only; holds nothing.
create or replace function public.film_resume_price(p_film public.films) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f         public.films := p_film;
  g         public.film_segments;
  q         jsonb;
  ln        jsonb;
  rf        jsonb;
  lines     jsonb := '[]'::jsonb;
  carried   jsonb := '[]'::jsonb;
  refusals  jsonb := '[]'::jsonb;
  done_id   uuid;
  done_chg  numeric;
  done_res  uuid;
  done_lf   uuid;
  rerun     boolean;
  orig      numeric;
  credits   numeric;
  known     boolean := true;
  orig_sum  numeric := 0;
  orig_rem  numeric;
  total     numeric;
  kf_left   boolean := false;
  clip_left uuid[] := '{}';
begin
  select * into g from public.film_segments x where x.film_id = f.id order by x.n desc limit 1;
  if g.id is null then
    return null;
  end if;
  q := public.film_price(f);
  for ln in select l from jsonb_array_elements(q -> 'lines') l loop
    done_id := null;
    done_chg := null;
    done_res := null;
    done_lf := null;
    orig := null;
    if ln ->> 'line' = 'assembly' then
      -- A paused film's assembly is never complete: 0215's film_settle_locked settles a segment whose assembly completed as
      -- 'completed' (the film ready) whatever reason reached it, and film_resume_precheck refuses a film with nothing left. So
      -- the assembly line is always priced again.
      orig := g.assembly_confirmed_credits;
    else
      select t.id, t.charged_credits, t.result_asset_id, t.result_last_frame_asset_id into done_id, done_chg, done_res, done_lf
        from public.film_takes t
       where t.segment_id = g.id and t.kind = ln ->> 'line' and t.scene_id is not distinct from (ln ->> 'scene_id')::uuid
         and t.shot_index = (ln ->> 'shot_index')::integer and public.film_resume_done(t)
       order by t.attempt desc limit 1;
      if done_id is not null then
        -- Rule 5: what was paid for it, by the take that was made (a carried copy says 0; its root take says what was charged).
        done_chg := (with recursive up(id, src, chg) as (
                       select t.id, t.carried_from_take_id, t.charged_credits from public.film_takes t where t.id = done_id
                       union all
                       select p.id, p.carried_from_take_id, p.charged_credits from public.film_takes p join up on p.id = up.src)
                     select u.chg from up u where u.src is null limit 1);
        carried := carried || jsonb_build_array(jsonb_build_object(
          'line', ln ->> 'line', 'scene_id', ln -> 'scene_id', 'position', ln -> 'position', 'shot_index', ln -> 'shot_index',
          'take_id', done_id, 'status', 'completed', 'result_asset_id', done_res, 'result_last_frame_asset_id', done_lf,
          'charged_earlier', done_chg, 'credits', 0));
        continue;
      end if;
      select t.confirmed_credits into orig from public.film_takes t
       where t.segment_id = g.id and t.kind = ln ->> 'line' and t.scene_id is not distinct from (ln ->> 'scene_id')::uuid
         and t.shot_index = (ln ->> 'shot_index')::integer
       order by t.attempt limit 1;
      if ln ->> 'line' = 'keyframe' then
        kf_left := true;
      elsif ln ->> 'line' in ('clip', 'extend') then
        clip_left := clip_left || (ln ->> 'scene_id')::uuid;
      end if;
    end if;
    credits := case when (ln ->> 'priced')::boolean then (ln ->> 'credits')::numeric end;
    if orig is null then
      known := false;
    else
      orig_sum := orig_sum + orig;
    end if;
    lines := lines || jsonb_build_array(ln || jsonb_build_object(
      'original_credits', orig, 'delta', credits - orig,
      'changed', case when credits is null or orig is null then null else credits <> orig end));
    if not (ln ->> 'priced')::boolean then
      refusals := refusals || jsonb_build_array(jsonb_build_object(
        'line', ln ->> 'line', 'scene_id', ln -> 'scene_id', 'position', ln -> 'position', 'shot_index', ln -> 'shot_index',
        'reason', ln ->> 'reason', 'detail', ln ->> 'detail'));
    end if;
  end loop;
  for rf in select r from jsonb_array_elements(q -> 'refusals') r where r ->> 'line' in ('scene', 'film') loop
    if (rf ->> 'line' = 'film' and (rf ->> 'reason' <> 'reference_missing' or kf_left))
       or (rf ->> 'line' = 'scene' and (rf ->> 'scene_id')::uuid = any (clip_left)) then
      refusals := refusals || jsonb_build_array(rf);
    end if;
  end loop;
  if jsonb_array_length(lines) = 0 then
    refusals := refusals || jsonb_build_array(jsonb_build_object('line', 'film', 'reason', 'nothing_to_resume',
                                                                 'detail', 'every take and the assembly of this film are made'));
  end if;
  if jsonb_array_length(refusals) = 0 then
    select sum((l ->> 'credits')::numeric) into total from jsonb_array_elements(lines) l;
  end if;
  orig_rem := case when known and jsonb_array_length(lines) > 0 then orig_sum end;
  -- A re-run of the assembly: the segment's assembly failed and every take is carried, so the assembly is the only line.
  rerun := g.assembly_status = 'failed' and jsonb_array_length(lines) = 1 and lines -> 0 ->> 'line' = 'assembly';
  return jsonb_build_object(
    'film_id', f.id, 'version', f.version, 'purpose', 'resume', 'resumed_from', g.id, 'resumed_from_n', g.n,
    'priced', total is not null, 'total', total,
    -- The token start_film_resume must be handed back: the version (save_film never bumps a paused film's, so start_film's shape
    -- check holds) and an md5 of exactly what is left, of which segment it continues, what it carries (each take with its result
    -- and last frame), and its total.
    'quote_id', case when total is not null
                     then format('fq-%s-%s', f.version,
                                 md5(jsonb_build_object('film', f.id, 'version', f.version, 'resume', g.id, 'lines', lines,
                                                        'carried', carried, 'total', total)::text)) end,
    'lines', lines, 'carried', carried, 'refusals', refusals,
    'original_remaining', orig_rem, 'delta', total - orig_rem,
    'changed', case when total is null or orig_rem is null then null else total <> orig_rem end,
    'rerun', rerun, 'previous_failure', case when g.assembly_status = 'failed' then g.settle_reason end,
    'assembly_retryable', case when rerun then public.film_assembly_retryable(g.settle_reason) end,
    'planned_seconds', q -> 'planned_seconds', 'assembly_minutes', q -> 'assembly_minutes');
end
$$;

-- The resume quote: what is left of a paused film at today's rates, with what stands in the way of resuming it now. start_film's
-- caller rules (owners and admins; in the exempt organization a platform owner or admin): only the person who may resume asks the
-- price of resuming. Holds nothing. A priced quote is stored (film_quotes, purpose 'resume', from_segment) for 30 minutes.
create or replace function public.quote_film_resume(p_film uuid, p_version integer) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid      uuid := auth.uid();
  org      uuid;
  f        public.films;
  g        uuid;
  q        jsonb;
  bad      jsonb;
  adult_   jsonb;
  st       jsonb;
  avail    numeric;
  active   integer;
  slots    jsonb;
  blocked  jsonb := '[]'::jsonb;
  exempt_  boolean;
  on_      boolean;
  paid     numeric;
  lim      jsonb := public.film_money_limits();
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.org_id into org from public.films x where x.id = p_film;
  if org is null or not public.is_org_member(org, 'viewer') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  exempt_ := public.credits_exempt(org);
  if not public.is_org_member(org, 'admin') or (exempt_ and not public.is_platform_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into f from public.films where id = p_film;
  if f.status <> 'paused' then
    perform public.creative_refuse('film_not_resumable',
      case when f.status = 'cancelled' then 'a cancelled film is not resumed; archive it, or make a new film from its storyboard'
           else format('a %s film is not resumed; only a paused one is', f.status) end, 'NS409');
  end if;
  if p_version is distinct from f.version then
    perform public.creative_refuse('film_changed', format('the film is at version %s', f.version), 'NS409');
  end if;
  select x.id into g from public.film_segments x where x.film_id = f.id order by x.n desc limit 1;
  if exists (select 1 from public.film_segments x where x.film_id = f.id and x.status in ('queued', 'running', 'draining')) then
    perform public.creative_refuse('film_not_resumable', 'this film is running already', 'NS409');
  end if;
  bad := public.film_resume_precheck(f, g);
  if bad ->> 'reason' = 'nothing_to_resume' then
    perform public.creative_refuse('nothing_to_resume', bad ->> 'detail', 'NS409');
  end if;
  perform public.film_take_rate('quote', (lim ->> 'quotes_per_hour')::integer);
  q := public.film_resume_price(f);
  -- 0192's adult refusals, as quote_film says them: such a quote is unpriced, so nothing is stored for a start to accept.
  adult_ := public.film_adult_refusals(f.id, uid);
  if jsonb_array_length(adult_) > 0 then
    q := q || jsonb_build_object('priced', false, 'total', null, 'quote_id', null, 'delta', null, 'changed', null,
                                 'refusals', coalesce(q -> 'refusals', '[]'::jsonb) || adult_);
  end if;
  if (q ->> 'priced')::boolean then
    insert into public.film_quotes (film_id, org_id, version, quote_id, total, created_by, expires_at, purpose, from_segment, carried)
    values (f.id, org, f.version, q ->> 'quote_id', (q ->> 'total')::numeric, uid,
            now() + make_interval(mins => (lim ->> 'quote_minutes')::integer), 'resume', g, q -> 'carried')
    on conflict (film_id, quote_id) do update set expires_at = excluded.expires_at, total = excluded.total;
  end if;
  delete from public.film_quotes where film_id = f.id and (version <> f.version or expires_at <= now());

  -- What stands in the way, read as quote_film reads it (0198's switch for this organization included).
  paid := (select coalesce(sum(x.captured_credits), 0) from public.film_segments x
            where x.film_id = f.id and x.status in ('settled', 'released'));
  on_ := public.film_studio_on_for(org);
  st := public.film_settings_of(org);
  avail := public.film_available(org);
  active := (select count(*) from public.film_segments s where s.org_id = org and s.status in ('queued', 'running', 'draining'));
  slots := public.org_run_slots(org);
  if not on_ then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'film_studio_disabled'));
  end if;
  -- Support may read the price (no hold); only an owner or admin member may resume on the organization's credits.
  if not public.is_org_spender(org, 'admin') then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'not_a_member'));
  end if;
  -- A re-run of an assembly whose failure the same takes cannot cure is priced (so the person sees it) and never startable.
  if (q ->> 'rerun')::boolean and not (q ->> 'assembly_retryable')::boolean then
    blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'assembly_not_retryable', 'word', q ->> 'previous_failure'));
  end if;
  if (q ->> 'priced')::boolean then
    -- The cap is the whole film's (0171: "no film whose total is above it may start"): what its segments captured plus this.
    if st ->> 'max_credits_per_film' is not null
       and paid + (q ->> 'total')::numeric > (st ->> 'max_credits_per_film')::numeric then
      blocked := blocked || jsonb_build_array(jsonb_build_object('reason', 'cap_exceeded', 'limit', st -> 'max_credits_per_film',
                                                                 'captured', paid));
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
  return q || jsonb_build_object(
    'exempt', exempt_, 'available', avail, 'settings', st, 'active_films', active, 'film_studio_enabled', on_,
    'run_slot', jsonb_build_object('uses_run_slot', not exempt_, 'slots', slots,
                                   'max_hours', (lim ->> 'unclaimed_hours')::integer + (lim ->> 'deadline_hours')::integer
                                                + (lim ->> 'grace_hours')::integer),
    'quote_expires_at', (select x.expires_at from public.film_quotes x where x.film_id = f.id and x.quote_id = q ->> 'quote_id'),
    'blocked_by', blocked, 'may_start', public.is_org_spender(org, 'admin'),
    'startable', (q ->> 'priced')::boolean and jsonb_array_length(blocked) = 0,
    'limits', lim);
end
$$;

-- Resume a paused film at a resume quote the caller confirmed: one new segment and one new hold for what is left, the carried takes
-- in it at 0 (see the header). Idempotent on the caller's key, as start_film: the same key with the same film and quote answers the
-- first segment, with another one it is a conflict. The refusals come in start_film's order, and from the count on they are returned.
create or replace function public.start_film_resume(p_film uuid, p_quote_id text, p_idempotency_key text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  org     uuid;
  f       public.films;
  s       public.film_segments;
  g       uuid;
  q       jsonb;
  st      jsonb;
  ln      jsonb;
  bad     jsonb;
  ct      public.film_takes;
  sid     uuid := gen_random_uuid();
  ref     text;
  exempt_ boolean;
  total   numeric;
  hash    text;
  asm     jsonb;
  n_takes integer := 0;
  n_carry integer := 0;
  v       integer;
  w       text;
  d       text;
  msg     text;
  fq      public.film_quotes;
  gs      public.film_segments;
  rerun   boolean;
  paid    numeric;
  lim     jsonb := public.film_money_limits();
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
  -- 0215 (the owner's decision, 22 Nov): spending an organization's credits takes a seat in it. 0043's accessible_org_ids makes a
  -- platform owner or admin an admin of every organization; that stays read-only support access, and only an owner or admin
  -- MEMBER (org_members) holds the organization's credits. In the exempt organization the credits are the platform's own, so its
  -- platform owner or admin may, as before. Who may call is refused before anything is counted.
  if not public.is_org_spender(org, 'admin') then
    perform public.creative_refuse('not_a_member',
      'you are not an owner or admin member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
  end if;
  -- 0192's adult refusals, first once the caller is known to be the organization's admin, as start_film asks them.
  bad := public.film_adult_refusals(p_film, uid) -> 0;
  if bad is not null then
    perform public.creative_refuse(bad ->> 'reason', bad ->> 'detail');
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$' then
    perform public.creative_refuse('invalid_idempotency_key', 'the idempotency key must be 8 to 128 letters, digits or _.:-');
  end if;
  if p_quote_id is null or p_quote_id !~ '^fq-[0-9]{1,9}-[0-9a-f]{32}$' then
    perform public.creative_refuse('invalid_params', 'quote_id must be the quote_id quote_film_resume answered');
  end if;
  -- Never the same hash as start_film's for the same film and quote: a key used to start a film never replays as a resume.
  hash := md5(jsonb_build_object('film', p_film, 'quote', p_quote_id, 'purpose', 'resume')::text);

  -- start_film's own lock: one start or resume per organization at a time, so the replay lookup, the active-film count and the hold
  -- cannot be raced, by a second resume or by a start.
  perform pg_advisory_xact_lock(hashtextextended('film_start:' || org::text, 0));
  select * into s from public.film_segments where org_id = org and idempotency_key = p_idempotency_key;
  if found then
    if s.request_hash <> hash then
      perform public.creative_refuse('idempotency_conflict', 'this idempotency key was used to start another film or quote', 'NS409');
    end if;
    return (public.film_segment_json(s) - 'worker_id') || jsonb_build_object('ok', true, 'replayed', true);
  end if;

  -- The cheap refusals, before anything is counted or priced.
  select * into f from public.films where id = p_film for no key update;
  if f.status <> 'paused' then
    -- A film this resume (or another) already took on is queued or running: a new key is refused here, never a second segment.
    perform public.creative_refuse('film_not_resumable',
      case when f.status = 'cancelled' then 'a cancelled film is not resumed; archive it, or make a new film from its storyboard'
           else format('a %s film cannot be resumed; only a paused one can', f.status) end, 'NS409');
  end if;
  if split_part(p_quote_id, '-', 2)::integer <> f.version then
    perform public.creative_refuse('film_changed',
      format('the film was edited after this quote (it is at version %s); quote it again', f.version), 'NS409');
  end if;
  if not public.film_studio_on_for(org) then
    perform public.creative_refuse('film_studio_disabled', 'Film Studio is not switched on yet; nothing was held', 'NS409');
  end if;
  select x.id into g from public.film_segments x where x.film_id = f.id order by x.n desc limit 1;
  if exists (select 1 from public.film_segments x where x.film_id = f.id and x.status in ('queued', 'running', 'draining')) then
    perform public.creative_refuse('film_not_resumable', 'this film is running already', 'NS409');
  end if;
  bad := public.film_resume_precheck(f, g);
  if bad is not null then
    perform public.creative_refuse(bad ->> 'reason', bad ->> 'detail',
                                   case when bad ->> 'reason' = 'nothing_to_resume' then 'NS409' else 'NS400' end);
  end if;
  -- A re-run of the assembly (it failed, and every take is done and carried): only for a failure the same takes may cure. The word
  -- is the segment's settle_reason, which the worker settles a failed assembly with (modules/film_orchestrator.py, _assembly).
  select * into gs from public.film_segments where id = g;
  rerun := gs.assembly_status = 'failed'
           and not exists (select 1 from public.film_takes t where t.segment_id = g
                            group by t.kind, t.scene_id, t.shot_index having not bool_or(public.film_resume_done(t)));
  if rerun and not public.film_assembly_retryable(gs.settle_reason) then
    perform public.creative_refuse('assembly_not_retryable', format('word=%s', coalesce(gs.settle_reason, 'none')), 'NS409');
  end if;
  -- What the quote carried must still be what it was: each take completed, with the same result and last frame, both still in the
  -- library. Anything else since the quote is a changed film, refused before anything is counted. The files are locked FOR SHARE
  -- first and stay locked to commit, so none of them can be soft-deleted between this check and the carried copies below.
  perform 1 from public.media_assets a
   where a.id in (select (c ->> k)::uuid
                    from public.film_quotes x, jsonb_array_elements(coalesce(x.carried, '[]'::jsonb)) c,
                         unnest(array['result_asset_id', 'result_last_frame_asset_id']) k
                   where x.film_id = f.id and x.quote_id = p_quote_id and x.purpose = 'resume' and x.from_segment = g
                     and c ->> k is not null)
   order by a.id
     for share;
  if exists (select 1 from public.film_quotes x, jsonb_array_elements(coalesce(x.carried, '[]'::jsonb)) c
              where x.film_id = f.id and x.quote_id = p_quote_id and x.purpose = 'resume' and x.from_segment = g
                and not exists (select 1 from public.film_takes t
                                 where t.id = (c ->> 'take_id')::uuid and t.segment_id = g
                                   and t.result_asset_id is not distinct from (c ->> 'result_asset_id')::uuid
                                   and t.result_last_frame_asset_id is not distinct from (c ->> 'result_last_frame_asset_id')::uuid
                                   and public.film_resume_done(t))) then
    perform public.creative_refuse('film_changed',
      'a take this quote carries changed or its file was deleted since the quote; quote the resume again', 'NS409');
  end if;
  perform public.film_take_rate('start', (lim ->> 'starts_per_hour')::integer);

  -- Counted: from here every refusal is returned, so the counter commits with it. The stored resume quote first (no pricing yet).
  select * into fq from public.film_quotes x
   where x.film_id = f.id and x.quote_id = p_quote_id and x.version = f.version and x.purpose = 'resume' and x.from_segment = g;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'price_changed', 'code', 'NS409',
                              'detail', 'this is not a resume quote of the film as it stands; quote the resume again');
  end if;
  if fq.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'quote_expired', 'code', 'NS409',
                              'detail', 'this quote has expired; quote the resume again');
  end if;
  st := public.film_settings_of(org);
  if not exempt_ and fq.total > public.film_available(org) then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_credits', 'code', 'NS402',
                              'detail', format('available=%s needed=%s', public.film_available(org), fq.total));
  end if;
  -- The cap is the whole film's (0171: "no film whose total is above it may start"): what its segments captured plus this resume.
  paid := (select coalesce(sum(x.captured_credits), 0) from public.film_segments x
            where x.film_id = f.id and x.status in ('settled', 'released'));
  if st ->> 'max_credits_per_film' is not null and paid + fq.total > (st ->> 'max_credits_per_film')::numeric then
    return jsonb_build_object('ok', false, 'reason', 'cap_exceeded', 'code', 'NS400',
      'detail', format('this film has cost %s credits, resuming it costs %s more, and the organization allows %s a film', paid,
                       fq.total, st ->> 'max_credits_per_film'));
  end if;
  if (select count(*) from public.film_segments x where x.org_id = org and x.status in ('queued', 'running', 'draining'))
     >= (st ->> 'max_active_films')::integer then
    return jsonb_build_object('ok', false, 'reason', 'limit_reached', 'code', 'NS400',
      'detail', format('at most %s films of this organization run at once; wait for one to finish', st ->> 'max_active_films'));
  end if;

  -- Then the re-pricing of what is left, at today's rates: what was confirmed is what is held, in either direction.
  q := public.film_resume_price(f);
  if not (q ->> 'priced')::boolean then
    bad := q -> 'refusals' -> 0;
    return jsonb_build_object('ok', false, 'reason', bad ->> 'reason', 'code', 'NS400', 'detail', bad ->> 'detail');
  end if;
  total := (q ->> 'total')::numeric;
  if q ->> 'quote_id' <> p_quote_id then
    return jsonb_build_object('ok', false, 'reason', 'price_changed', 'code', 'NS409',
                              'detail', format('resuming now costs %s credits; quote the resume again', total));
  end if;
  -- 0187's rights acknowledgement, asked of the person who resumes (and pays) exactly as start_film asks it.
  bad := public.film_acknowledgement_missing(f, uid);
  if bad is not null then
    return jsonb_build_object('ok', false, 'reason', 'acknowledgement_required', 'code', 'NS400',
      'detail', format('kind=%s version=%s subject=%s', bad ->> 'kind', coalesce(bad ->> 'text_version', 'none'), bad ->> 'subject'));
  end if;

  -- The hold, for the resume total only: 0020's reserve_credits in the admin's own session, before anything is created, with
  -- start_film's answers to its refusals.
  ref := 'fm-' || replace(sid::text, '-', '');
  if exempt_ or total = 0 then
    ref := null;
  else
    begin
      perform public.reserve_credits(org, ref, total);
    exception when sqlstate 'NS402' or sqlstate 'NS429' or sqlstate '22023' or sqlstate '23505' then
      get stacked diagnostics w = returned_sqlstate, d = pg_exception_detail, msg = message_text;
      if w in ('22023', '23505') then
        perform public.film_log(f.id, org, null, 'start_refused',
          jsonb_build_object('reason', 'hold_refused', 'code', w, 'quote_id', p_quote_id, 'credits', total, 'resume', true,
                             'message', left(coalesce(nullif(d, ''), msg), 200)));
      end if;
      return jsonb_build_object('ok', false,
                                'reason', case w when 'NS402' then 'insufficient_credits' when 'NS429' then 'run_slots_full'
                                                 else 'hold_refused' end,
                                'code', w, 'detail', coalesce(nullif(d, ''), msg));
    end;
  end if;

  select l into asm from jsonb_array_elements(q -> 'lines') l where l ->> 'line' = 'assembly';
  insert into public.film_segments (id, film_id, org_id, n, purpose, resumed_from, film_version, quote_id, status, credit_ref, exempt,
                                    confirmed_credits, assembly_minutes, assembly_unit_credits, assembly_confirmed_credits,
                                    max_attempts, idempotency_key, request_hash, created_by)
  values (sid, f.id, org, coalesce((select max(x.n) from public.film_segments x where x.film_id = f.id), 0) + 1, 'resume', g,
          f.version, p_quote_id, 'queued', ref, exempt_, total, (asm ->> 'quantity')::integer,
          (asm ->> 'credits_per_unit')::numeric, (asm ->> 'credits')::numeric,
          (lim ->> 'max_attempts')::integer, p_idempotency_key, hash, uid)
  returning * into s;

  -- The carried takes: a copy of each take the earlier segment completed, in this segment, completed, at 0, with the same result and
  -- last frame, so 0198's film_take_job finds a next take's inputs here and the assembly cuts this segment's takes. Never charged:
  -- film_takes_carried_check holds it in the table. The version is the next of its scene (or of the narration), as start_film
  -- numbers a take, so every take of a scene in this segment is one version.
  for ct in select t.* from public.film_takes t
             where t.id in (select (c ->> 'take_id')::uuid from jsonb_array_elements(q -> 'carried') c)
             order by t.scene_id nulls last, t.shot_index, t.id loop
    v := coalesce((select max(t.version) from public.film_takes t
                    where t.film_id = f.id and t.scene_id is not distinct from ct.scene_id
                      and t.kind = case when ct.kind = 'narration' then 'narration' else t.kind end
                      and t.segment_id is distinct from sid), 0) + 1;
    insert into public.film_takes (film_id, org_id, scene_id, version, shot_index, kind, attempt, status, model, prompt_final, params,
                                   duration_s, first_frame_asset_id, last_frame_asset_id, reference_asset_ids, result_asset_id,
                                   result_last_frame_asset_id, segment_id, credit_unit, unit_credits, quantity, minimum_credits,
                                   confirmed_credits, charged_credits, charge_basis, output_seconds, started_at, finished_at,
                                   carried_from_take_id)
    values (f.id, org, ct.scene_id, v, ct.shot_index, ct.kind, 1, 'completed', ct.model, ct.prompt_final, ct.params, ct.duration_s,
            ct.first_frame_asset_id, ct.last_frame_asset_id, ct.reference_asset_ids, ct.result_asset_id,
            ct.result_last_frame_asset_id, sid, ct.credit_unit, ct.unit_credits, ct.quantity, ct.minimum_credits,
            0, 0, 'carried_not_charged', ct.output_seconds, ct.started_at, ct.finished_at, ct.id);
    n_carry := n_carry + 1;
  end loop;
  -- A carried extend continues the carried copy of the shot before it, not the earlier segment's row.
  update public.film_takes c
     set parent_take_id = p.id
    from public.film_takes o, public.film_takes p
   where c.segment_id = sid and c.carried_from_take_id = o.id and o.parent_take_id is not null
     and p.segment_id = sid and p.carried_from_take_id = o.parent_take_id;

  for ln in select l from jsonb_array_elements(q -> 'lines') l where l ->> 'line' in ('keyframe', 'clip', 'extend', 'narration') loop
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
  perform public.film_log(f.id, org, null, case when rerun then 'assembly_rerun' else 'resumed' end,
    jsonb_build_object('segment_id', sid, 'resumed_from', g, 'quote_id', p_quote_id, 'credits', total, 'held', ref is not null,
                       'exempt', exempt_, 'takes', n_takes, 'carried', n_carry, 'version', f.version,
                       'original_remaining', q -> 'original_remaining')
    || case when rerun then jsonb_build_object('previous_failure', gs.settle_reason) else '{}'::jsonb end);
  return (public.film_segment_json(s) - 'worker_id')
         || jsonb_build_object('ok', true, 'replayed', false, 'resumed_from', g, 'carried', n_carry, 'rerun', rerun);
end
$$;

-- Re-run a failed assembly: the thin door for "every take is made, only the film's assembly failed". start_film_resume's caller
-- rules and its quote (quote_film_resume prices the assembly line only here). Refused unless the film's newest segment ended with
-- its assembly failed and every take completed (not_assembly_failure), or when a made take's file was deleted since (film_changed:
-- a re-run carries the takes as they are, it never makes one again; resuming makes it again). Everything else, the retryable word,
-- the replay and the lock included, is start_film_resume's, which this calls as it is.
create or replace function public.rerun_film_assembly(p_film uuid, p_quote_id text, p_idempotency_key text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  org uuid;
  gs  public.film_segments;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.org_id into org from public.films x where x.id = p_film;
  if org is null or not public.is_org_member(org, 'viewer') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(org, 'admin') or (public.credits_exempt(org) and not public.is_platform_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The owner's rule of start_film_resume (it asks it again): only a member spends, the exempt organization's platform staff aside.
  if not public.is_org_spender(org, 'admin') then
    perform public.creative_refuse('not_a_member',
      'you are not an owner or admin member of this workspace; ask the workspace''s owner to add you as a member', 'NS400');
  end if;
  -- A replay of a re-run answers as start_film_resume answers it (its first answer), whatever the film is now.
  if not exists (select 1 from public.film_segments x where x.org_id = org and x.idempotency_key = p_idempotency_key) then
    select * into gs from public.film_segments x where x.film_id = p_film order by x.n desc limit 1;
    if gs.id is null or gs.assembly_status <> 'failed'
       or exists (select 1 from public.film_takes t where t.segment_id = gs.id
                   group by t.kind, t.scene_id, t.shot_index having not bool_or(t.status = 'completed')) then
      perform public.creative_refuse('not_assembly_failure',
        'only a film whose every take is made and whose assembly failed is assembled again; resume it instead', 'NS409');
    end if;
    if exists (select 1 from public.film_takes t where t.segment_id = gs.id
                group by t.kind, t.scene_id, t.shot_index having not bool_or(public.film_resume_done(t))) then
      perform public.creative_refuse('film_changed',
        'a made take''s file was deleted since; a re-run carries the takes as they are: resume the film to make it again', 'NS409');
    end if;
  end if;
  return public.start_film_resume(p_film, p_quote_id, p_idempotency_key);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Privileges
-- ───────────────────────────────────────────────────────────────────────────

-- Members read which segment a resume continues (0171's column grant pattern; RLS as 0171 set it). carried_from_take_id is not
-- granted: a carried take's charge_basis (carried_not_charged, granted by 0171) already says what it is.
grant select (resumed_from) on public.film_segments to authenticated;

revoke all on function public.film_resume_done(public.film_takes) from public, anon, authenticated, service_role;
revoke all on function public.film_assembly_retryable(text) from public, anon, authenticated, service_role;
revoke all on function public.rerun_film_assembly(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.rerun_film_assembly(uuid, text, text) to authenticated;
revoke all on function public.film_resume_precheck(public.films, uuid) from public, anon, authenticated, service_role;
revoke all on function public.film_resume_price(public.films) from public, anon, authenticated, service_role;
revoke all on function public.quote_film_resume(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.start_film_resume(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.quote_film_resume(uuid, integer) to authenticated;
grant execute on function public.start_film_resume(uuid, text, text) to authenticated;
-- The replaced bodies keep their earlier grants (create or replace keeps them); restated so a replay leaves the same state.
revoke all on function public.film_read(uuid) from public, anon, authenticated, service_role;
revoke all on function public.archive_film(uuid) from public, anon, authenticated, service_role;
grant execute on function public.archive_film(uuid) to authenticated;
revoke all on function public.start_film(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.start_film(uuid, text, text) to authenticated;
revoke all on function public.film_claim_segment(text, interval) from public, anon, authenticated, service_role;
grant execute on function public.film_claim_segment(text, interval) to service_role;
revoke all on function public.claim_creative_job(text, interval) from public, anon, authenticated, service_role;
grant execute on function public.claim_creative_job(text, interval) to service_role;
revoke all on function public.film_settle_locked(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.quote_film(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.quote_film(uuid, integer) to authenticated;
revoke all on function public.is_org_spender(uuid, text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.film_read(uuid)', '981acaa80ff158976f8b9c70b547b270'),
      ('public.archive_film(uuid)', '55c7d0a270fd61f65d6aee32f4af3c67'),
      ('public.start_film(uuid, text, text)', '4ff45b2145f8cf3e4abab7befacb5971'),
      ('public.film_claim_segment(text, interval)', '8f5fc37c0d0a5223e5f53e1a6e62e770'),
      ('public.claim_creative_job(text, interval)', '7a0a6d9b16d1b03a4e99a35e577e8711'),
      ('public.film_settle_locked(uuid, uuid, text)', 'aed04169cd567e5b9f971412c92b5323'),
      ('public.quote_film(uuid, integer)', 'ce64d1e3843a163c088943758036fdf8'),
      ('public.is_org_spender(uuid, text)', '91b76ea25715c4b6d66b6adbc1f6a885'),
      ('public.film_resume_done(public.film_takes)', '74a15de06371eb06e694c7e1ef75d891'),
      ('public.film_assembly_retryable(text)', '82ec51dabd0ff178ec2280bc0c56e62b'),
      ('public.rerun_film_assembly(uuid, text, text)', '077e568b33d99c5e2056a66ca3e22121'),
      ('public.film_resume_precheck(public.films, uuid)', 'aa7275ed5e8520af52cabd03c2f930d8'),
      ('public.film_resume_price(public.films)', 'cb0951bf0db3f3ff4858607eb7d948b0'),
      ('public.quote_film_resume(uuid, integer)', '82168c33540974bd5972f89e4daceaeb'),
      ('public.start_film_resume(uuid, text, text)', 'b8d3d8099e9788d629ef4f003d659936')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception '0215 end state: % does not hold this file''s body (md5 %)', r.sig, h;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.quote_film_resume(uuid, integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.start_film_resume(uuid, text, text)', 'execute')
     or has_function_privilege('anon', 'public.quote_film_resume(uuid, integer)', 'execute')
     or has_function_privilege('anon', 'public.start_film_resume(uuid, text, text)', 'execute')
     or has_function_privilege('service_role', 'public.start_film_resume(uuid, text, text)', 'execute')
     or has_function_privilege('service_role', 'public.quote_film_resume(uuid, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.film_resume_price(public.films)', 'execute')
     or has_function_privilege('service_role', 'public.film_resume_price(public.films)', 'execute')
     or has_function_privilege('authenticated', 'public.film_resume_precheck(public.films, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.film_resume_done(public.film_takes)', 'execute')
     or has_function_privilege('service_role', 'public.film_resume_done(public.film_takes)', 'execute')
     or has_function_privilege('authenticated', 'public.film_assembly_retryable(text)', 'execute')
     or not has_function_privilege('authenticated', 'public.rerun_film_assembly(uuid, text, text)', 'execute')
     or has_function_privilege('anon', 'public.rerun_film_assembly(uuid, text, text)', 'execute')
     or has_function_privilege('service_role', 'public.rerun_film_assembly(uuid, text, text)', 'execute')
     or has_function_privilege('service_role', 'public.film_resume_precheck(public.films, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.archive_film(uuid)', 'execute')
     or has_function_privilege('anon', 'public.archive_film(uuid)', 'execute')
     or has_function_privilege('service_role', 'public.archive_film(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.film_read(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.start_film(uuid, text, text)', 'execute')
     or has_function_privilege('service_role', 'public.start_film(uuid, text, text)', 'execute')
     or not has_function_privilege('service_role', 'public.film_claim_segment(text, interval)', 'execute')
     or has_function_privilege('authenticated', 'public.film_claim_segment(text, interval)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_creative_job(text, interval)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_creative_job(text, interval)', 'execute')
     or has_function_privilege('service_role', 'public.film_settle_locked(uuid, uuid, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.quote_film(uuid, integer)', 'execute')
     or has_function_privilege('anon', 'public.quote_film(uuid, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.is_org_spender(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.is_org_spender(uuid, text)', 'execute')
     or has_column_privilege('authenticated', 'public.film_takes', 'carried_from_take_id', 'select')
     or has_column_privilege('authenticated', 'public.film_segments', 'worker_id', 'select')
     or not has_column_privilege('authenticated', 'public.film_segments', 'resumed_from', 'select')
     or has_table_privilege('authenticated', 'public.film_quotes', 'select')
     or has_table_privilege('service_role', 'public.film_takes', 'insert')
     or has_table_privilege('service_role', 'public.film_segments', 'insert') then
    raise exception '0215 end state: a grant is not what this file sets';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.film_segments'::regclass and conname = 'film_segments_state_check'
                    and pg_get_constraintdef(oid) like '%''resume''%')
     or not exists (select 1 from pg_constraint where conrelid = 'public.film_segments'::regclass and conname = 'film_segments_resume_check')
     or not exists (select 1 from pg_constraint where conrelid = 'public.film_takes'::regclass and conname = 'film_takes_carried_check')
     or not exists (select 1 from pg_constraint where conrelid = 'public.film_quotes'::regclass and conname = 'film_quotes_purpose_check')
     or not exists (select 1 from pg_constraint where conrelid = 'public.film_quotes'::regclass
                       and conname = 'film_quotes_from_segment_fk') then
    raise exception '0215 end state: a constraint is missing';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (read-only, run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.archive_film(uuid)'::regprocedure) = '55c7d0a270fd61f65d6aee32f4af3c67'                    as archive_takes_paused,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_read(uuid)'::regprocedure) = '981acaa80ff158976f8b9c70b547b270'                          as history_without_worker,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.film_claim_segment(text,interval)'::regprocedure) = '8f5fc37c0d0a5223e5f53e1a6e62e770' as claim_records_a_ref,
--   to_regprocedure('public.quote_film_resume(uuid, integer)') is not null
--     and to_regprocedure('public.start_film_resume(uuid, text, text)') is not null                   as resume_exists,
--   (select pg_get_constraintdef(oid) like '%''resume''%' from pg_constraint
--     where conrelid = 'public.film_segments'::regclass and conname = 'film_segments_state_check')    as segments_may_resume,
--   not exists (select 1 from public.film_takes
--                where carried_from_take_id is not null and (charged_credits <> 0 or confirmed_credits <> 0)) as carried_never_charged,
--   has_function_privilege('authenticated', 'public.start_film_resume(uuid, text, text)', 'execute')
--     and not has_function_privilege('anon', 'public.start_film_resume(uuid, text, text)', 'execute')
--     and not has_function_privilege('service_role', 'public.start_film_resume(uuid, text, text)', 'execute') as grants_ok;
-- -- Rows written before 0215 may still hold detail.worker; film_read strips it, and a member's direct select of film_events.detail
-- -- or creative_job_events.detail still shows it: docs/MIGRATIONS.md (0215) names the owner's optional redaction.
