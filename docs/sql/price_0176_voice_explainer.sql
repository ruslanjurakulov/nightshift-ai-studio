-- price_0176_voice_explainer.sql — the credit price of the Studio's voice video (migration 0176, model nightshift-voice-explainer).
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it, and the app never writes a price on its own.
--
-- WHEN. Only after the model was probed ON THE WORKER (docs/VOICE_EXPLAINER.md, "Opening it", steps 1 to 6): this file refuses
-- while the registry row is missing or has no passing probe, so a price can never be the first thing that makes it look ready.
-- It does not open the model: availability is set afterwards, on the Models page.
--
-- THE PRICE (owner decision, 2026-11-14). Customers pay 0.4 credits per second of recording (24 credits per minute). The two
-- numbers that make it (credits_per_unit and margin) are priced from credit_prices; see the owner's private pricing notes. They are NOT in this file: fill in the two
-- constants below from those notes before running it. As shipped, both are NULL and the file refuses to run (see NEVER 0, NEVER NULL).
-- The quantity is the recording's length as the DATABASE measured it (creative_source_seconds), never a client's number, and
-- job_minimum still floors a short one. A ten-minute recording (the longest 0176 takes) is 240 credits.
--
-- Remotion: the owner is a one-person company, so Remotion's Free License applies ("for individuals and companies of up to 3
-- people", remotion.dev/docs/license/pricing, read 2026-11-14). Re-check when the company has more than 3 people, or on Remotion
-- 5.0 (the licence terms may change).
--
-- NEVER 0, NEVER NULL. creative_price floors a job at job_minimum only when the unit's price is above 0: a zero row would make
-- every voice video free. This file refuses to write 0, a negative or a NULL rate, and a margin outside 0..10 (the table's
-- CHECK). To stop selling, take the model's availability away (Models page) or delete the row; never set it to 0.
--
-- Idempotent: insert ... on conflict (unit) do update, so running it again writes the same row. Only credit_prices changes.

begin;

do $$
declare
  -- The two numbers. Set them here and nowhere else; the checks below run on whatever is written.
  v_unit constant text := 'model_nightshift_voice_explainer_second';
  -- Both from the owner's private pricing notes (not in the repository). NULL refuses to run: a missing figure never writes a price.
  v_credits_per_unit constant numeric := null;
  v_margin constant numeric := null;
  v_note constant text :=
    '0176 voice video, owner 2026-11-14: 0.4 credits/s (24/min), priced from the owner''s pricing notes. '
    'docs/sql/price_0176_voice_explainer.sql';
  m record;
begin
  if v_credits_per_unit is null or v_credits_per_unit <= 0 then
    raise exception 'price_0176 refuses credits_per_unit %: 0 or NULL makes every voice video free (job_minimum applies only above 0)',
      coalesce(v_credits_per_unit::text, 'NULL');
  end if;
  if v_margin is null or v_margin < 0 or v_margin > 10 then
    raise exception 'price_0176 refuses margin %: it must be between 0 and 10', coalesce(v_margin::text, 'NULL');
  end if;
  if v_credits_per_unit * (1 + v_margin) <= 0 then
    raise exception 'price_0176 refuses a rate that charges nothing';
  end if;

  select id, credit_unit, verified_at into m from public.model_registry where id = 'nightshift-voice-explainer';
  if not found then
    raise exception 'price_0176 found no model row nightshift-voice-explainer: sync the registry first (tools/probe_models.py --sync)';
  end if;
  if m.credit_unit is distinct from v_unit then
    raise exception 'price_0176: the model''s credit unit is %, not %: read schemas/model_registry.json first', m.credit_unit, v_unit;
  end if;
  if m.verified_at is null then
    raise exception 'price_0176: nightshift-voice-explainer has no passing probe: probe it on the worker first (docs/VOICE_EXPLAINER.md, "Opening it")';
  end if;

  insert into public.credit_prices (unit, credits_per_unit, margin, note)
  values (v_unit, v_credits_per_unit, v_margin, v_note)
  on conflict (unit) do update
    set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin, note = excluded.note, updated_at = now();
end $$;

-- Verify (expected: one row whose credits_per_second is 0.4).
select unit, credits_per_unit, margin, credits_per_unit * (1 + margin) as credits_per_second
  from public.credit_prices where unit = 'model_nightshift_voice_explainer_second';

commit;
