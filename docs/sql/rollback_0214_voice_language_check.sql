-- rollback_0214_voice_language_check.sql — takes migration 0214 (voice_language_problem) out again.
-- Run it only after any quote_film body that calls voice_language_problem has been put back to one that does not: a quote would
-- otherwise stop with "function does not exist". The registry's tts languages stay in model_registry.spec (they are the file's
-- facts, not this migration's); nothing else is touched.
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname <> 'voice_language_problem'
                and p.prosrc like '%voice_language_problem%') then
    raise exception 'rollback 0214: a function still calls voice_language_problem; put its earlier body back first';
  end if;
end
$$;

drop function if exists public.voice_language_problem(text, text);

do $$
begin
  if to_regprocedure('public.voice_language_problem(text,text)') is not null then
    raise exception 'rollback 0214 end state: voice_language_problem is still there';
  end if;
end
$$;
