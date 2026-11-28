-- 0246_film_take_progress.sql — a running take's vendor percent and status word, and the assembly's measured percent
-- (docs/studio/LIVE_CREATION_PLAN.md section 3 item 7, "Progress honesty"; build order item 5).
--
-- EVIDENCE. The live view (/api/films/[id]/live) shows a running take as "running" from its first poll to its last, a few
--   seconds to several minutes, with nothing moving. Runway's GET /v1/tasks/{id} answers a progress fraction (0..1, read
--   2026-11-28) that the video adapter parsed and modules/creative_adapters.py dropped; every adapter parses its vendor's
--   status word ("queued", "running", ...) and dropped it too. The assembly's ffmpeg can report how far it is (-progress),
--   and nothing asked it.
-- CHANGE. Additive only:
--   * film_takes: progress (a percent, 0..100, NULL = not known), vendor_state (one short lowercase word, NULL = not known),
--     progress_at (when either was last written). film_segments: assembly_progress (0..100, NULL = not known) and
--     assembly_progress_at. Each column has a CHECK that holds the same rule as the writer.
--   * film_take_progress(take, worker, progress, word) and film_segment_assembly_progress(segment, worker, progress): the
--     only writers, SECURITY DEFINER, executable by service_role only, and they write only for the worker that holds the
--     segment (film_segments.worker_id, the rule of 0171's film_heartbeat_segment) while the take (or the assembly) runs;
--     anything else answers false and writes nothing. The take writer locks the film, then the segment (and asks for the
--     worker again), then the take, film_lock_take's order, and never waits on the take while holding the other two: a lease
--     taken over while a write waited is seen (Breach B-0246-1). The assembly writer is one UPDATE of the segment itself, whose
--     worker_id Postgres re-checks on the row's newest version after a wait, as film_heartbeat_segment's. A figure outside 0..100 (or NaN) is written as NULL, never clamped;
--     a word that is not one short lowercase word is NULL (no free text: no prompt, error, task id or money can pass).
--   * Members read the five columns through RLS, as they read the rest of the take and the segment (0166, 0171).
--   Not changed: every body of 0166, 0171, 0198 and 0215 (no function is replaced, so nothing is md5-guarded but this
--   file's own two, which a re-run may replace only with the same body).
-- NUMBER. 0246, assigned by Atlas (live creation plan, section 4). Needs 0171 (film_segments, film_takes.segment_id).
-- Rollback: docs/sql/rollback_0246_film_take_progress.sql (owner-applied).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
-- No backslash anywhere in this file: the live apply path once rewrote backslash escapes inside SQL text (0219's header).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regclass('public.film_segments') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'film_takes'
                     and column_name = 'segment_id') then
    raise exception '0246 needs 0171 (film_segments, film_takes.segment_id): apply it first';
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.film_take_progress(uuid, text, numeric, text)');
  if h is not null and h <> '28911b1d6dbdd1bb6176c9617c1aba8c' then
    raise exception '0246 found a film_take_progress that is not this file''s (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.film_segment_assembly_progress(uuid, text, numeric)');
  if h is not null and h <> 'bac224571284b836694d51f2aed8bccb' then
    raise exception '0246 found a film_segment_assembly_progress that is not this file''s (md5 %): read the live body first', h;
  end if;
end $$;

alter table public.film_takes add column if not exists progress numeric(5,2);
alter table public.film_takes add column if not exists vendor_state text;
alter table public.film_takes add column if not exists progress_at timestamptz;
alter table public.film_segments add column if not exists assembly_progress numeric(5,2);
alter table public.film_segments add column if not exists assembly_progress_at timestamptz;

alter table public.film_takes drop constraint if exists film_takes_progress_check;
alter table public.film_takes add constraint film_takes_progress_check
  check ((progress is null or (progress >= 0 and progress <= 100))
         and (vendor_state is null or vendor_state ~ '^[a-z][a-z0-9_]{0,31}$'));
alter table public.film_segments drop constraint if exists film_segments_assembly_progress_check;
alter table public.film_segments add constraint film_segments_assembly_progress_check
  check (assembly_progress is null or (assembly_progress >= 0 and assembly_progress <= 100));

comment on column public.film_takes.progress is
  '0246: the vendor''s own percent for this running take (0..100), NULL when it reports none. Written by film_take_progress only.';
comment on column public.film_takes.vendor_state is
  '0246: the vendor''s own status word for this running take (queued, running, ...), one short lowercase word, NULL when not known.';
comment on column public.film_segments.assembly_progress is
  '0246: the assembly render''s measured percent (media seconds encoded over twice the timeline), NULL when not known.';

create or replace function public.film_take_progress(p_take uuid, p_worker text, p_progress numeric, p_vendor_state text)
  returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w     text := left(btrim(coalesce(p_worker, '')), 120);
  -- A figure outside 0..100 (or NaN) is dropped, never clamped; a word that is not one short lowercase word is dropped.
  pct   numeric := case when p_progress >= 0 and p_progress <= 100 then round(p_progress, 2) end;
  word  text := case when p_vendor_state ~ '^[a-z][a-z0-9_]{0,31}$' then p_vendor_state end;
  fid   uuid;
  seg   uuid;
  tries integer := 0;
  hit   integer;
begin
  if w = '' then
    return false;
  end if;
  select x.film_id, x.segment_id into fid, seg from public.film_takes x where x.id = p_take;
  if seg is null then
    return false;
  end if;
  loop
    tries := tries + 1;
    begin
      -- The film, then the segment, then the take: film_lock_take's order. The segment is locked and asked again here, so a
      -- worker whose lease was taken over while this waited answers false (B-0246-1: a joined segment row is not re-checked).
      perform 1 from public.films where id = fid for no key update;
      perform 1 from public.film_segments s
        where s.id = seg and s.worker_id = w and s.status in ('running', 'draining') for share;
      if not found then
        return false;
      end if;
      -- Never wait on the take while holding the film and the segment: a take locked by someone else is waited for below,
      -- with nothing held, and everything is asked again.
      perform 1 from public.film_takes where id = p_take for no key update nowait;
      update public.film_takes
         set progress = pct, vendor_state = word, progress_at = now()
       where id = p_take and segment_id = seg and status = 'running';
      get diagnostics hit = row_count;
      return hit > 0;
    exception when lock_not_available then
      if tries >= 3 then
        return false;
      end if;
      begin
        perform 1 from public.film_takes where id = p_take for no key update;
        raise exception using errcode = 'P0001', message = 'film_take_progress: the take is free, ask again';
      exception when raise_exception then
        null;
      end;
    end;
  end loop;
end
$$;

create or replace function public.film_segment_assembly_progress(p_segment uuid, p_worker text, p_progress numeric)
  returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w   text := left(btrim(coalesce(p_worker, '')), 120);
  pct numeric := case when p_progress >= 0 and p_progress <= 100 then round(p_progress, 2) end;
  hit integer;
begin
  if w = '' then
    return false;
  end if;
  update public.film_segments
     set assembly_progress = pct, assembly_progress_at = now()
   where id = p_segment and worker_id = w and status in ('running', 'draining') and assembly_status = 'running';
  get diagnostics hit = row_count;
  return hit > 0;
end
$$;

revoke all on function public.film_take_progress(uuid, text, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.film_segment_assembly_progress(uuid, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.film_take_progress(uuid, text, numeric, text) to service_role;
grant execute on function public.film_segment_assembly_progress(uuid, text, numeric) to service_role;

grant select (progress, vendor_state, progress_at) on public.film_takes to authenticated;
grant select (assembly_progress, assembly_progress_at) on public.film_segments to authenticated;

-- The end state, asserted inside the transaction.
do $$
declare
  h text;
begin
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = 'public.film_take_progress(uuid, text, numeric, text)'::regprocedure;
  if h is distinct from '28911b1d6dbdd1bb6176c9617c1aba8c' then
    raise exception '0246 end state: film_take_progress is not this file''s body (md5 %)', h;
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = 'public.film_segment_assembly_progress(uuid, text, numeric)'::regprocedure;
  if h is distinct from 'bac224571284b836694d51f2aed8bccb' then
    raise exception '0246 end state: film_segment_assembly_progress is not this file''s body (md5 %)', h;
  end if;
  if has_function_privilege('authenticated', 'public.film_take_progress(uuid, text, numeric, text)', 'execute')
     or has_function_privilege('anon', 'public.film_take_progress(uuid, text, numeric, text)', 'execute')
     or not has_function_privilege('service_role', 'public.film_take_progress(uuid, text, numeric, text)', 'execute')
     or has_function_privilege('authenticated', 'public.film_segment_assembly_progress(uuid, text, numeric)', 'execute')
     or has_function_privilege('anon', 'public.film_segment_assembly_progress(uuid, text, numeric)', 'execute')
     or not has_function_privilege('service_role', 'public.film_segment_assembly_progress(uuid, text, numeric)', 'execute')
     or not has_column_privilege('authenticated', 'public.film_takes', 'progress', 'select')
     or not has_column_privilege('authenticated', 'public.film_takes', 'vendor_state', 'select')
     or not has_column_privilege('authenticated', 'public.film_segments', 'assembly_progress', 'select')
     or has_column_privilege('authenticated', 'public.film_takes', 'progress', 'update')
     or has_column_privilege('authenticated', 'public.film_takes', 'provider_task_id', 'select')
     or has_table_privilege('service_role', 'public.film_takes', 'update')
     or has_table_privilege('service_role', 'public.film_segments', 'update') then
    raise exception '0246 end state: a grant is not what this file sets';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (read-only, run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) = 5 from information_schema.columns where table_schema = 'public'
--      and (table_name, column_name) in (('film_takes', 'progress'), ('film_takes', 'vendor_state'), ('film_takes', 'progress_at'),
--                                        ('film_segments', 'assembly_progress'), ('film_segments', 'assembly_progress_at'))) as columns_there,
--   has_function_privilege('service_role', 'public.film_take_progress(uuid, text, numeric, text)', 'execute')
--     and not has_function_privilege('authenticated', 'public.film_take_progress(uuid, text, numeric, text)', 'execute') as writer_is_the_worker,
--   has_column_privilege('authenticated', 'public.film_takes', 'progress', 'select')
--     and has_column_privilege('authenticated', 'public.film_segments', 'assembly_progress', 'select')               as members_read_it,
--   not exists (select 1 from public.film_takes where progress < 0 or progress > 100)                                as in_range;
