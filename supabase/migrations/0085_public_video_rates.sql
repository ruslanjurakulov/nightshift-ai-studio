-- 0085_public_video_rates.sql — the two credit rates a visitor needs to read a
-- price before signing up: credits per finished minute of video, and the
-- smallest hold any run takes. Both AS CHARGED, readable by anyone.
--
-- Why: the public /pricing page and the landing say what a credit pack costs
-- in dollars, but not what a video costs in credits — credit_rates() (0084) is
-- signed-in only, so "$10 for 1,000 credits" never became "a minute of video
-- is N credits". The public site must not guess that number either (no
-- default, no hard-coded figure), so it reads it from the live price list.
--
-- WHAT IT ADDS (nothing is changed or dropped; no price changes)
--   public_video_rates()  NEW. (unit, credits_per_unit AS CHARGED) for exactly
--                         two units: video_minute (credits_per_unit x (1 +
--                         margin), the formula 0020's estimate and 0084's
--                         credit_rates() use) and job_minimum (a flat floor:
--                         its margin is ignored, as 0020 / 0084). No other
--                         unit, never the margin, the base rate or the note —
--                         the base next to the charged rate would give the
--                         margin by division (BR-G-001), so the base is not
--                         returned at all. An unset unit is simply absent
--                         (unpriced, never 0); the app reads a missing or zero
--                         per-minute rate as "not published".
--
-- WHO MAY DO WHAT
--   public_video_rates   execute: anon, authenticated. It is a price list:
--                        what every member already reads through
--                        credit_rates(), for the two units a price page names.
--
-- DEPLOY ORDER: either way round. The Command Center reads this function and,
-- while it is missing, says no per-minute rate is published (as before).
--
-- REQUIRES 0020 (credit_prices). Additive and idempotent: create-or-replace,
-- revoke-then-grant.

do $$
begin
  if to_regclass('public.credit_prices') is null then
    raise exception '0085 needs 0020_credits.sql: apply it first';
  end if;
end $$;

create or replace function public.public_video_rates()
  returns table (unit text, credits_per_unit numeric)
  language sql stable security definer set search_path = public, pg_temp as $$
  select cp.unit,
         -- The floor ignores its margin (0020 reserve_credits); the minute is
         -- charged with it.
         case when cp.unit = 'job_minimum' then cp.credits_per_unit
              else cp.credits_per_unit * (1 + cp.margin) end
    from public.credit_prices cp
   where cp.unit in ('video_minute', 'job_minimum')
   order by cp.unit
$$;

comment on function public.public_video_rates() is
  'The public price of a video (0085): video_minute and job_minimum only, credits per unit AS CHARGED (job_minimum flat). Never the margin, the base rate or the note. Anyone may read it.';

revoke all on function public.public_video_rates() from public, anon, authenticated, service_role;
grant execute on function public.public_video_rates() to anon, authenticated;

-- Verify (read-only):
-- select * from public.public_video_rates();
-- select has_function_privilege('anon', 'public.public_video_rates()', 'EXECUTE') as anon_reads,
--        (select prosecdef from pg_proc where oid = 'public.public_video_rates()'::regprocedure) as definer;
