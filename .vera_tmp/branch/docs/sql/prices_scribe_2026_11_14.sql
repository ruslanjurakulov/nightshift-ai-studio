-- prices_scribe_2026_11_14.sql: the Scribe v2 caption price, from a figure READ on the vendor's page.
-- OWNER-APPLY: paste into the Supabase SQL editor. This is NOT a migration. Nothing in the app runs it,
-- and the app never writes a price on its own.
--
-- WHY. prices_defaults_2026_10_03.sql seeded model_elevenlabs_scribe_v2_second at 0.0112 credits a
-- second as an 'est.:' row: an assumed $0.40 per audio hour, because no figure had been read. One has
-- now been read:
--
--   https://elevenlabs.io/pricing/api, read 2026-11-14: Scribe v2 speech-to-text, $0.20 per hour.
--
--   $0.20 / 3600 s = $0.0000556/s = 0.00556 cents/s, rounded up to 0.0056 (1 credit = 1 cent of cost,
--   the convention of prices_2026_10_01.sql). The customer pays 0.0056 x (1 + 2.0) = 0.0168 cr/s,
--   about 60 credits an hour of audio. Margin 2.0, as for every voice unit.
--
-- SAFE TO RE-RUN, AND IT DOES NOT OVERWRITE THE OWNER. It changes the rate only while it still holds the
-- seeded estimate (0.0112) or this file's own value, so a price the owner set by hand is left alone; the
-- margin of an existing row is never touched. If the row does not exist yet (the defaults file was never
-- applied), it is inserted. APPLY ORDER: step 5, after prices_defaults_2026_10_03.sql.

update public.credit_prices
   set credits_per_unit = 0.0056,
       note = 'ElevenLabs API pricing (elevenlabs.io/pricing/api, read 2026-11-14): Scribe v2 $0.20/h = 0.0056 cr/s.'
 where unit = 'model_elevenlabs_scribe_v2_second'
   and credits_per_unit in (0.0112, 0.0056);

insert into public.credit_prices (unit, credits_per_unit, margin, note) values
  ('model_elevenlabs_scribe_v2_second', 0.0056, 2.0,
   'ElevenLabs API pricing (elevenlabs.io/pricing/api, read 2026-11-14): Scribe v2 $0.20/h = 0.0056 cr/s.')
on conflict (unit) do nothing;

-- Check (read-only): one row at 0.0056 (margin unchanged; 2.0 on a row this file inserted). Another rate
-- means the owner had set one; it was kept.
--   select unit, credits_per_unit, margin, note from public.credit_prices
--    where unit = 'model_elevenlabs_scribe_v2_second';
