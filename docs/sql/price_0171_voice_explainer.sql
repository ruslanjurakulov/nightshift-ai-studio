-- price_0171_voice_explainer.sql — the credit price of the Studio's voice video (migration 0171, model nightshift-voice-explainer).
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it, and the app never writes a price on its own.
--
-- WHEN. Only after the model was probed ON THE WORKER (docs/VOICE_EXPLAINER.md, "Opening it", steps 1 to 6): this file refuses
-- while the registry row is missing or has no passing probe, so a price can never be the first thing that makes it look ready.
-- It does not open the model: availability is set afterwards, on the Models page.
--
-- THE PRICE (owner decision, 2026-11-14). credits_per_unit 0.05 per second of recording, margin 7.0:
--   0.05 x (1 + 7.0) = 0.4 credits per second = 24 credits per minute of recording
--   ≈ $0.24 a minute at retail ($0.01 per credit), ≈ $0.17 at the Studio plan's $0.0072 per credit.
-- The quantity is the recording's length as the DATABASE measured it (creative_source_seconds), never a client's number, and
-- job_minimum still floors a short one. A ten-minute recording (the longest 0171 takes) is 240 credits.
--
-- THE DERIVATION. There is no vendor bill: the cost is this server's own work.
--   * Measured render: 3.4x real time on 4 cores; memory ~+2.2 GB at 30 s and ~+3.8 GB at
--     121 s of recording, both measured BEFORE the engine rendered in chunks (docs/VOICE_EXPLAINER.md, "Capacity").
--   * The server: a Hetzner AX42, about $60 a month.
--   * Variable cost ≈ $0.007 per minute of recording: CPU including Whisper, storage of the result, and a 20% reserve for
--     renders that are retried.
--   * credits_per_unit 0.05 (3 cents of cost per minute) is the FULLY-LOADED unit cost, not the variable one: it also carries a
--     share of the server spread over ~500 minutes of recording a month, payment fees (~5%), refunds, and a reserve for a
--     future Remotion Company License. (The whole server over 500 minutes alone would be 12 cents a minute: 0.05 assumes the
--     voice video carries a share of it, not all of it. Revisit when the monthly minutes are measured.)
--   * Remotion: the owner is a one-person company, so Remotion's Free License applies ("for individuals and companies of up
--     to 3 people", remotion.dev/docs/license/pricing, read 2026-11-14): $0 today. Re-check when the company has more than
--     3 people, or on Remotion 5.0 (the licence terms may change).
--
-- NEVER 0, NEVER NULL. creative_price floors a job at job_minimum only when the unit's price is above 0: a zero row would make
-- every voice video free. This file refuses to write 0, a negative or a NULL rate, and a margin outside 0..10 (the table's
-- CHECK). To stop selling, take the model's availability away (Models page) or delete the row; never set it to 0.
--
-- Idempotent: insert ... on conflict (unit) do update, so running it again writes the same row. Only credit_prices changes.

begin;

do $$
declare
  -- The two numbers. Change them here and nowhere else; the checks below run on whatever is written.
  v_unit constant text := 'model_nightshift_voice_explainer_second';
  v_credits_per_unit constant numeric := 0.05;
  v_margin constant numeric := 7.0;
  v_note constant text :=
    '0171 voice video, owner 2026-11-14: fully-loaded cost 0.05/s (CPU incl. Whisper, storage, retries, server share, fees, '
    'refunds, licence reserve), margin 7.0 = 0.4 credits/s (24/min). docs/sql/price_0171_voice_explainer.sql';
  m record;
begin
  if v_credits_per_unit is null or v_credits_per_unit <= 0 then
    raise exception 'price_0171 refuses credits_per_unit %: 0 or NULL makes every voice video free (job_minimum applies only above 0)',
      coalesce(v_credits_per_unit::text, 'NULL');
  end if;
  if v_margin is null or v_margin < 0 or v_margin > 10 then
    raise exception 'price_0171 refuses margin %: it must be between 0 and 10', coalesce(v_margin::text, 'NULL');
  end if;
  if v_credits_per_unit * (1 + v_margin) <= 0 then
    raise exception 'price_0171 refuses a rate that charges nothing';
  end if;

  select id, credit_unit, verified_at into m from public.model_registry where id = 'nightshift-voice-explainer';
  if not found then
    raise exception 'price_0171 found no model row nightshift-voice-explainer: sync the registry first (tools/probe_models.py --sync)';
  end if;
  if m.credit_unit is distinct from v_unit then
    raise exception 'price_0171: the model''s credit unit is %, not %: read schemas/model_registry.json first', m.credit_unit, v_unit;
  end if;
  if m.verified_at is null then
    raise exception 'price_0171: nightshift-voice-explainer has no passing probe: probe it on the worker first (docs/VOICE_EXPLAINER.md, "Opening it")';
  end if;

  insert into public.credit_prices (unit, credits_per_unit, margin, note)
  values (v_unit, v_credits_per_unit, v_margin, v_note)
  on conflict (unit) do update
    set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin, note = excluded.note, updated_at = now();
end $$;

-- Verify (expected: one row, 0.05000000 | 7.0000 | 0.4).
select unit, credits_per_unit, margin, credits_per_unit * (1 + margin) as credits_per_second
  from public.credit_prices where unit = 'model_nightshift_voice_explainer_second';

commit;
