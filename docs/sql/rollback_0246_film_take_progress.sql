-- rollback_0246_film_take_progress.sql — removes 0246's two writers and five columns. Owner-applied, one transaction.
-- What the columns held is lost (it is only ever "how far a running take was"). No backslash anywhere in this file.
begin;
set local lock_timeout = '5s';
drop function if exists public.film_take_progress(uuid, text, numeric, text);
drop function if exists public.film_segment_assembly_progress(uuid, text, numeric);
alter table public.film_takes drop constraint if exists film_takes_progress_check;
alter table public.film_segments drop constraint if exists film_segments_assembly_progress_check;
alter table public.film_takes drop column if exists progress, drop column if exists vendor_state, drop column if exists progress_at;
alter table public.film_segments drop column if exists assembly_progress, drop column if exists assembly_progress_at;
do $$
begin
  if to_regprocedure('public.film_take_progress(uuid, text, numeric, text)') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'film_takes'
                 and column_name in ('progress', 'vendor_state', 'progress_at')) then
    raise exception 'rollback 0246: something of 0246 is still there';
  end if;
end $$;
commit;
