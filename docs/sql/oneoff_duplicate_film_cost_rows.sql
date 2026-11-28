-- oneoff_duplicate_film_cost_rows.sql — find, and only then remove, the second cost row a film take's ONE vendor call got
-- from the resume window of PR #964 (fixed by the PR after it). Owner-run, by hand, in the Supabase SQL editor. Never run by
-- a worker, a migration or an agent. No backslash anywhere in this file.
--
-- THE WINDOW. #964's film worker wrote a take's delivered cost row as soon as the vendor answered, before the job recorded
-- 'processing'. A worker that died (or whose 'processing' step was refused or out of reach) between the two left a
-- 'submitted' job; the claim that resumed it polled the same task again and wrote the same row a second time. The vendor
-- billed once. The same could happen before #964 to a job resumed while already 'processing'.
--
-- THE KEY, and why it is safe. A film take's creative job (payer 'film', 0198's film_take_job) makes exactly ONE vendor
-- call, except the narration (capability 'tts'), which makes one call per scene and may give two scenes rows that look
-- alike (same unit, same character count): the narration is left out. A retry is a new take with a new job, never a
-- second call on the same job. So two DELIVERED rows (price_source NULL, usd_estimate NULL, as the adapters write them) of
-- one such job with the same provider, model, unit and quantity are one call written twice. The first one written is
-- kept. A failed_call row is never a candidate, nor is a row with a price.
--
-- The readers do not drop these rows on their own: a key that is safe here (it reads creative_jobs.payer and capability)
-- cannot be asked by the dashboards, which read creative_job_costs alone.

-- 1. READ FIRST. Every candidate, with the row it duplicates. Nothing is changed.
with c as (
  select c.id, c.job_id, j.film_take_id, c.provider, c.vendor_model, c.unit, c.quantity, c.recorded_at,
         row_number() over (partition by c.job_id, c.provider, c.vendor_model, c.unit, c.quantity
                            order by c.recorded_at, c.id) as n,
         first_value(c.id) over (partition by c.job_id, c.provider, c.vendor_model, c.unit, c.quantity
                                 order by c.recorded_at, c.id) as kept_id
    from public.creative_job_costs c
    join public.creative_jobs j on j.id = c.job_id
   where j.payer = 'film' and j.film_take_id is not null and j.capability <> 'tts'
     and c.price_source is null and c.usd_estimate is null
)
select id as duplicate_id, kept_id, job_id, film_take_id, provider, vendor_model, unit, quantity, recorded_at
  from c
 where n > 1
 order by job_id, recorded_at;

-- 2. ONLY IF step 1 listed exactly the rows to remove: the same predicate, in one transaction. creative_job_costs is
--    append-only (0037's trigger), so the trigger is switched off for this transaction's delete and back on before the
--    commit. Compare the count it reports with step 1's row count; if they differ, run ROLLBACK instead of COMMIT.
--
-- begin;
-- alter table public.creative_job_costs disable trigger creative_job_costs_append_only;
-- with c as (
--   select c.id,
--          row_number() over (partition by c.job_id, c.provider, c.vendor_model, c.unit, c.quantity
--                             order by c.recorded_at, c.id) as n
--     from public.creative_job_costs c
--     join public.creative_jobs j on j.id = c.job_id
--    where j.payer = 'film' and j.film_take_id is not null and j.capability <> 'tts'
--      and c.price_source is null and c.usd_estimate is null
-- )
-- delete from public.creative_job_costs d using c where d.id = c.id and c.n > 1;
-- alter table public.creative_job_costs enable trigger creative_job_costs_append_only;
-- commit;
