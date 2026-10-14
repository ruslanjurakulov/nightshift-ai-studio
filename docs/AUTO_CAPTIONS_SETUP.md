# Auto-captions: what the owner must set up

Auto-captions turn the speech in a video or recording into word-timed subtitles in the editor. The code for the
whole chain is in the product. What is missing on a fresh deployment is **configuration only**: a transcription
key on the worker, a model that has passed a real probe, a price, and the "on sale" switch. Until all four exist the
editor's Captions panel says "Auto-captions are not available yet: no transcription is set up and priced on this
deployment" and nothing can be bought. This page lists exactly what to do. It contains no secrets: you type the
key values yourself, in the places named below, and never into a chat, an issue or a commit.

## What already works (no setup)

Panel button -> price quote (shown on the button before anything is held) -> your priced press (credits held,
one idempotency key, `max_credits` = the quote) -> job -> worker -> transcription provider -> words with start and
end seconds stored as a caption track (`caption_tracks`) -> cues appear in the panel -> look, edit, split, join,
add, delete, fix a word everywhere -> the export burns the captions in (the same ffmpeg path as every text on the
picture); SRT and WebVTT download from the same cues.

- Languages: Uzbek, Russian, English, or "detect it" (no language is sent, the provider detects it and the
  detected language is stored with the transcript). The database allow-list is `uz`, `ru`, `en`; a model is sold
  only in the languages it lists (`languages` in its registry entry).
- Limit: a recording of up to **30 minutes** (the database measures the length itself; the editor refuses a longer
  one before pricing). At most 20 000 words per transcript (more is refused, never cut) and 5 000 captions in one
  project.
- Money: the price is the recording's length in seconds times the model's credit rate. The credits are held when
  you press, charged only when the transcript is stored, and returned in full on every failure (no speech, a
  refused file, an outage, a rejected key, a cancel). An unpriced model is never free: the quote answers
  `unpriced` and the panel says "This model has no price yet".
- Nothing is published, re-rendered or spent without the person's own priced press. Reusing a transcript that was
  already made is free.

## What you must configure

Do these in order. Steps 1 and 2 are one time per deployment; 3-6 are per transcription model.

### 1. The database must have captions (migration 0072)

Migrations are applied by hand. Captions need `0072_captions.sql` (and the ones it is built on: 0035, 0036, 0038,
0050, 0052, 0055, 0060, 0070; 0084 and later keep its lines). Check in the Supabase SQL editor:

```sql
select to_regclass('public.caption_tracks') is not null as captions_table,
       position('captions' in pg_get_functiondef('public.creative_price(uuid,text,text,jsonb)'::regprocedure)) > 0 as priced;
```

Both must be `true`. If not, the panel says "Auto-captions are not enabled on this deployment yet". No new
migration is needed for the code in this change.

### 2. The creative worker must be running

`NIGHTSHIFT_WORKER` and `NIGHTSHIFT_CREATIVE_WORKER` = `on` (see `docs/DEPLOY_AX42.md`, "Creative worker"). The
worker is where the provider key lives; the web server never sees it.

### 3. The provider key (worker environment)

Pick one provider. Both are already registered, hidden, unpriced and not for sale.

| Model id | Provider key name (worker env / repository secret) | Strong at | Notes |
| :-- | :-- | :-- | :-- |
| `elevenlabs-scribe-v2` | `ELEVENLABS_API_KEY` | Uzbek (about 10-20% word errors), Russian, English | One synchronous request per recording. The key is already forwarded to the worker by the deploy workflow if you use ElevenLabs voices. Its vendor terms for offering the service to end users need a **Scale, Business or Enterprise plan**. |
| `assemblyai-universal-2` | `ASSEMBLYAI_API_KEY` (optional `ASSEMBLYAI_BASE_URL`, https only, for the EU host) | Russian, English | Asynchronous (upload, create, poll). Uzbek is in the vendor's lowest accuracy tier, so this model is registered for `ru` and `en` only. The deploy workflow does **not** forward this key yet: add `WORKERENV_ASSEMBLYAI_API_KEY: ${{ secrets.ASSEMBLYAI_API_KEY }}` beside the other `WORKERENV_` lines in `.github/workflows/deploy_web.yml` (a one-line change deliberately not made in this change), or put `ASSEMBLYAI_API_KEY=` into the server's `.env.worker` by hand. |

For Uzbek, use `elevenlabs-scribe-v2`. Add the key as a GitHub repository secret with exactly that name (the
deploy workflow writes it to the worker's env file) and run **Deploy web**. For the probe in step 5 you also need
`ELEVENLABS_API_KEY` and a repository **variable** `ELEVENLABS_VOICE_ID` (any voice id from the account): the probe
makes a few seconds of speech with text-to-speech first, then transcribes it. That holds for either provider.

### 4. Clear the vendor terms gate (registry file, a reviewed code change)

Both entries carry `terms_gate` in `schemas/model_registry.json`, and the database refuses to put a gated model on
sale. Clear it only after the vendor's terms are satisfied:

- `elevenlabs-scribe-v2`: `"terms_gate": "plan_required:scale"` -> `null` once the account is on a qualifying plan.
- `assemblyai-universal-2`: `"terms_gate": "terms_review_required"` -> `null` once you have read the vendor's
  terms for offering transcription to your customers.

Open a pull request that changes that one line, merge it, and let the deploy run. This is a decision for the
owner, which is why it is not made in the code.

### 5. Verify the model with a real probe (this is the only paid check)

A model is offered only after one real call through its adapter has worked. Either:

- GitHub: **Actions -> Probe models -> Run workflow**, `model` = the model id from the table. It copies the
  registry file into the database, makes the probe, and prints only `ok <id>`, `failed <id> <error code>` or
  `skipped <id>` (skipped = the key is not set). The probe is the registry's cheapest request: a short spoken
  sentence made by text-to-speech, then transcribed. It is a few seconds of audio, so the cost is small (the vendor bills by audio length), and it records `verified_at`.
- or on the worker machine: `python tools/probe_models.py --model elevenlabs-scribe-v2` (add `--sync` the first
  time).

No provider call is free; the **free** checks are:

1. `python tools/probe_models.py --dry-run --model elevenlabs-scribe-v2`: shows what would be called and whether
   the key is present on this machine. No network, no database, no spend.
2. `pytest tests/test_captions.py tests/test_async_transcribe.py`: the whole job (price, hold, words, track,
   refunds) against fake providers.
3. In the editor, with everything configured: the **price on the button is a quote**. Nothing is held and nothing
   is called until you press it, so you can check the price for any clip for free.

The first real end-to-end test is then a 5-10 second clip: press the button, wait for "Transcript ready", put the
captions on the video, export. If it fails, the credits come back in full.

### 6. Turn it on: the price, then the switch

The order matters because the database checks both:

1. **Price.** Credits page -> price list (operator only): add a row with the model's credit unit as the *unit*, the
   credits per **second of recording** as the *rate*, and your margin:
   - `elevenlabs-scribe-v2` -> unit `model_elevenlabs_scribe_v2_second`
   - `assemblyai-universal-2` -> unit `model_assemblyai_universal_2_second`

   `docs/sql/prices_defaults_2026_10_03.sql` already holds a starting row for the ElevenLabs unit (it says "est.":
   an assumption of the vendor's hourly price, to be confirmed on your plan). It is owner-apply SQL, nothing runs
   it by itself, and there is no row for the AssemblyAI unit: set that one yourself.

   Customer credits = recording seconds x rate x (1 + margin). Set it from the vendor's per-hour price on your
   plan (neither is hard-coded anywhere; no number in this repository is a price). A model without a row, or with
   a rate of 0, is not sold.
2. **Switch.** Models page -> manage view (operator only) -> set the model to `beta` (or `ga`). The database
   refuses this until the model has a successful probe (step 5) and no open terms gate (step 4).

The Captions panel then offers the model (the editor reads `sellable_models('captions')`: verified, priced, no
open terms gate). Captions are never sold through the API or MCP: the transcript can only be read by a signed-in
member.

## What the panel says, and what it means

| The panel says | Meaning | Fix |
| :-- | :-- | :-- |
| "Auto-captions are not available yet: no transcription is set up and priced on this deployment." | The database is ready but no model is verified, unblocked, priced and switched on | Steps 3-6 |
| "Auto-captions are not enabled on this deployment yet" | `0072` is not applied (or its capability is unknown to the database) | Step 1 |
| "We could not check whether auto-captions are available just now" | The list could not be read (database error); not the same as "not set up" | Reload; check the database |
| "This model has no price yet, so it cannot be used." (after pressing nothing: shown with the quote) | The model is on sale but its credit unit has no positive rate | Step 6.1 |
| "This model is not available right now." | The model was switched off or lost its proof between the page load and the quote | Step 5-6 |
| Job failed, "Something went wrong on our side" | The worker has no key, the key was rejected, or the vendor answered something unexpected; the credits came back | Step 3; the job row has a code: `not_configured`, `auth`, `bad_response` |
| Job failed, "The service was busy or too slow" | Vendor outage, rate limit, empty vendor balance (`unavailable`, `rate_limited`, `quota`) or the job ran past 45 minutes | Retry; top up the vendor account |
| Job failed, "No speech was found in this recording" | The recording is silent; nothing was charged | None |
| Job failed, "These settings were not accepted" | The vendor refused this file (format, language) | Another file or language |

## Operating notes

- The recording is read from the media library by id and copied to the worker; the file name the person uploaded is
  never sent to the vendor. The vendor's answer is reduced to words and times (control characters, zero-width and
  bidirectional marks are removed, times forced forward and inside the recording) before it is stored.
- A worker restart in the middle of an asynchronous transcript keeps the vendor's task id and resumes polling; a
  synchronous one (ElevenLabs) is failed and refunded if the worker dies in the middle of the request.
- Provider cost is recorded in the provider's own unit (seconds of recording) with the USD left empty until a
  confirmed price is pinned in the registry (`pricing.provider_usd_per_unit` with its `source_url` and `as_of`).
  Margin and cost reports show it as unknown, never zero.
- Keys are read only from the worker's environment and are scrubbed from every message the adapter produces.

## Not verified by the code review (needs a real key)

- A real call to either vendor: both adapters are written against the vendors' published API references and tested
  against fakes. The first real probe is the proof. In particular AssemblyAI's word times are read as milliseconds
  (from their examples; the reference does not state the unit), and its "no speech" error text is matched by
  words.
- Real Uzbek accuracy on your content; the quality tiers above are the vendors' own statements.
- Large recordings (several hundred MB) through the real network path.
