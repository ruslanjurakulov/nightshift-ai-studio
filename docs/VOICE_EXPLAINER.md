# Voice to 2D video (slice 1a: the engine; slice 1b: the Studio tool, migration 0171)

A person's own narration in, a 9:16 motion-graphics explainer out: every sentence gets a
small kicker line, a big headline with one marked word, one drawn visual and an italic
accent line, with word-timed captions, a music bed and a whoosh on every cut. Everything
is drawn in code (Remotion), nothing by an image or video model.

Why: competitors sell this as a one-tap format (docs/research/competitors.md §10). We
already had the parts (Whisper word timings, the Remotion engine, music and effects); this
slice joins them.

## What exists after this slice

| Part | Where |
| :-- | :-- |
| Composition `VoiceExplainer` (one render for the whole video) | `video-engine/src/explainer/` |
| Five looks: `dusk`, `midnight`, `golden`, `neon`, `paper` | `looks.ts`, mirrored in `modules/voice_explainer.LOOKS` |
| Visual catalogue: `characters` (4 settings, 7 poses, 6 props), `card`, `stat`, `progress`, `emoji`, `checklist`, `chat`, `none` | `types.ts`, `Characters.tsx`, `Visuals.tsx` |
| Words → sentences → scene windows; planners; validation; props; render | `modules/voice_explainer.py` |
| Operator command | `tools/voice_to_video.py` |

```bash
python tools/voice_to_video.py --audio narration.mp3 --look dusk --out out/explainer.mp4
```

- `--planner rules` (default): free, offline, deterministic. The headline is the
  sentence's longest content word, a spoken number becomes a counter, the rest rotate
  through the character scenes and the reaction face.
- `--planner model`: one Gemini call (`GEMINI_API_KEY`, the `script` stage model) writes
  the kicker, headline and accent and picks each visual. Its answer is validated against
  the catalogue. A plan that does not fit is refused, with the field named, and nothing is
  rendered; it is never replaced by the rules plan (CLAUDE.md rule 4).
- `--plan plan.json`: a plan you wrote (one object per sentence), validated the same way.
- `--words track.json`: skip Whisper (`[{"text","start_s","end_s"}]`, Whisper's
  `{"word","start","end"}`, or the captions track's `{"t","s","e"}`).
- `--music bed.mp3`, `--sfx-dir assets/sfx` (or `none`), `--no-captions`, `--browser`
  (a Chrome; `CHRONOS_REMOTION_BROWSER`).

Everything a run needs is checked before the transcription and the (paid) planner. A failure says what to do:
- the recording must exist, be readable and be at most 600 s;
- the look must exist;
- the engine must be installed;
- the effects must be present;
- with `--planner model`, a key must be set;
- `npx` must be on the path, and the frame settings must be even sizes up to 4096 and 1 to 60 fps.

Then, on the words: a word track that runs past the recording (another take) is refused. A last word that overshoots
by less than half a second (ffprobe's estimate of a VBR mp3) is clamped. A counter shows a spoken number only as it
was said ("10 000", "$1,500"): a value it cannot read unambiguously appears as written and is never re-punctuated.

## Measured

A 30 s Uzbek narration (54 words, 8 sentences) rendered to 1080×1920 at 30 fps in 80 s
with one Remotion worker, in a 4-core cloud container. The mixed audio's mean level was
-24.9 dB against the narration's -23.7 dB, so the music does not drown the voice.

## Slice 1b: "Voice to video" in the Studio (migration 0171)

A person picks one of their library recordings (their own narration, audio only, at most 600 s) and one of the five looks on
the Studio's **Voice** desk, sees the database's price, and presses Generate. The creative worker draws the video on this
server with the engine above and stores it in the media library. It is an ordinary creative job: quote, hold, capture, and
a full release on every failure (`create_creative_job`, 0036; nothing new in the money path). The MCP Studio tools
(`list_models`, `quote_generation`, `create_generation`, `get_generation`) offer it too, with the same params.

| Part | Where |
| :-- | :-- |
| The capability `voice_explainer`: params, source, price, the CHECKs, the API's list | `supabase/migrations/0171_voice_video.sql` (rollback: `docs/sql/rollback_0171_voice_video.sql`) |
| The adapter (our own engine; its one vendor call is ElevenLabs Scribe, the transcription) | `modules/capabilities/voice_video.py` (`video.voice_explainer`) |
| The registry entry (ships dark, terms-gated `plan_required:scale`) | `schemas/model_registry.json` `nightshift-voice-explainer` (vendor model `voice-explainer-rules-2` = the rules planner with `scribe_v2`; `rules-1` was the same engine with local Whisper) |
| The shared speech-to-text form and the vendor's error words | `modules/capabilities/audio.py` (`scribe_form`, `elevenlabs_error_word`), also used by the captions job (0072) |
| The worker's lists and its one render slot | `modules/creative_worker.py` (`SOURCE_` / `MEDIA_SOURCE_` / `AUDIO_SOURCE_` / `SERIAL_CAPABILITIES`, `OUTPUT_KIND`) |
| The price (owner-applied, after the probe) | `docs/sql/price_0171_voice_explainer.sql` |
| The Studio tool | `command-center/lib/creative/{operations,studio,desks}.ts`, `components/studio/GeneratePanel.tsx` (Voice desk) |
| The worker image | `Dockerfile.worker`: Node 22, the engine (`npm ci`), Remotion's headless Chrome, its Debian libraries, Inter and fontconfig, the effects, a warm render cache |

### What the database decides (0171)

- **params**: `source_asset_id` (required: an audio file of the organization's library) and `look` (required: one of
  `dusk`, `midnight`, `golden`, `neon`, `paper`, and one the model lists in `spec.explainer_looks`). Everything else is
  refused: no words, shape, resolution, length, seed, voice, language or style. Both keys existed already (0046, 0099).
- **source**: an AUDIO file of THIS organization, live, MP3 / M4A / WAV / OGG / FLAC / AAC / WebM, of a measured length of at
  most 600 s, at most 200 MB. Another organization's file reads exactly like one that does not exist.
- **price**: the recording's seconds as the DATABASE measured them (`creative_source_seconds`), never a client's number, at the
  model's `credit_unit` rate (`model_nightshift_voice_explainer_second`) with its margin, floored at `job_minimum`. A model that
  states no `limits.max_source_seconds` is not sold; a longer recording is refused before anything is held.
- **the proof**: a change of `spec.explainer_looks` (or of the vendor model, i.e. the engine build) clears the model's probe, so it
  is hidden until probed again (`model_registry_guard`).

### What the worker does

The copied recording is first decoded to a PCM WAV in the job's own folder (ffmpeg), and only that copy is measured,
transcribed and rendered. A browser recording (MediaRecorder's `audio/webm;codecs=opus`) is written as a stream: its header
carries no duration, so ffprobe has no length for it and Remotion cannot seek in it; the decoded copy has both. Its length
must be within 1 s of the length the library measured, which is what the job was priced on; another length is not the
recording that was sold, and the job is refused before anything is sent to be transcribed.

**The transcription is ElevenLabs Speech to Text (Scribe), one paid call per job** (owner decision 2026-11-14: it takes
Whisper's CPU and memory off the render machine, and Uzbek is the weakest language of Whisper `base`; how much better Scribe
reads our recordings is measured with `tools/stt_compare.py`, below, not assumed). A 16 kHz mono 16-bit copy of the decoded
narration (`speech.wav`, about 19 MB for 600 s; the narration itself is rendered at its own rate) is sent to
`POST /v1/speech-to-text` with the captions job's form (`model_id scribe_v2`, `timestamps_granularity word`, no speaker labels,
no audio-event tags), the key in the `xi-api-key` header, redirects not followed. No language is named: 0176's params carry
none, so Scribe detects it. Only `type: word` entries are kept (spacing and audio events are dropped) and they are cleaned
exactly as a captions track is (`modules/captions.clean_words`: control and bidi characters out, times forward, at most 20 000
words). A word that comes back without its times is left out, never placed at 0 (the captions job's rule; the count goes to
the operator's log, never the words); if none has times, that is the vendor's fault (`bad_response`), never "no speech".
**There is no fallback to local Whisper** (CLAUDE.md rule 4): when Scribe refuses or cannot be reached, the job fails, the hold
is released and the error names the fix.

Then `fit_words` → `split_sentences` → `plan_rules` → `build_scenes` → `sound_cues` → `build_props` → `render`, exactly as
`tools/voice_to_video.py --planner rules` does. **The rules planner only**: deterministic and free. No Gemini call is made inside
a paid job: a model planner would be a second provider whose failure the person's hold pays for. It is a later slice with its own
vendor model (`voice-explainer-model-…`), probe and price; the adapter refuses any vendor model but `voice-explainer-rules-2`, and
a change of the Scribe model is a new vendor model too (so the probe is cleared, never carried over).

The adapter is synchronous: the render happens inside `submit`, and the finished file is handed to the worker by its path (a
ten-minute video is hundreds of MB; it is moved, never read into memory). Like every synchronous adapter, a worker that restarts
between the render and the store has lost it: the job fails `output_lost` and the hold is released in full (nothing is charged,
nothing is rendered twice).

No silent fallback anywhere (CLAUDE.md rule 4). Every refusal fails the job, releases the hold, and names its fix:

| What | Code | Why it is not something else |
| :-- | :-- | :-- |
| The engine is not installed on this worker (no `npx`, `ffmpeg` or `ffprobe`, no `npm ci` in `video-engine/`, Remotion's browser not downloaded or a `CHRONOS_REMOTION_BROWSER` that is not a file, no effects, fontconfig not answering `Inter`), or `ELEVENLABS_API_KEY` is not in its env | `not_configured` | Checked before anything runs; it is also what `configured()` (and so the probe) reads. Without Inter, Chrome would set the words in another face; without the key there is no transcription (Whisper is not a requirement, so it cannot quietly stand in). The key is named, never shown. |
| ElevenLabs rejects the key (`invalid_api_key`, `missing_api_key`) | `auth` | "set a valid ELEVENLABS_API_KEY for the creative worker". Read from the vendor's `detail.code` (or the legacy `detail.status`), never from the HTTP status alone (rule 6). |
| The ElevenLabs account is out of credits or its plan does not include it (`insufficient_credits`, `payment_required`, the legacy 401 `quota_exceeded`) | `quota` | "top up ElevenLabs (or change the plan)". The opposite fix of a wrong key, though both can be a 401. |
| ElevenLabs is limiting requests (`rate_limit_exceeded`, `concurrent_limit_exceeded`) | `rate_limited` | Retryable: try again in a few minutes. |
| ElevenLabs is busy or unreachable (`system_busy`, a 5xx, a network failure, a redirect), or did not answer in time (60 s + 0.5 s per second of recording, at most 420 s) | `unavailable` | Retryable: try again later. The vendor may still bill an abandoned call; the person is not charged. |
| ElevenLabs cannot read the copy it was sent (`invalid_audio_format`, `request_too_large`) | `bad_request` | Export the recording again and upload that. |
| The recording does not decode as sound, decodes to a length more than 1 s from the library's, is longer than 600 s, or has no words | `bad_request` | The person's fix. "No words" (an empty transcript) is this adapter's own refusal, never a vendor fault, and never a silent or captionless video. |
| The decoded copy cannot be measured | `bad_response` | The worker just wrote it: this machine's failure, not the recording's. |
| The word track does not belong to the recording | `bad_request` | `fit_words` refuses it before the render. |
| The transcription's answer cannot be read (not JSON, no `words`, the multichannel shape, words without any times), the 16 kHz copy could not be made, or the call crashed | `bad_response` | This machine's or the vendor's failure, never reported as "no words". |
| Remotion failed | `bad_response` | Its log tail goes to the operator's log only: it names this machine's paths. |
| The render ran out of time (600 s + 6 s per second of narration) | `unavailable` | A busy machine: try again later. |
| The worker was told to stop (SIGTERM) during the job | `unavailable` | The render's process group is killed, or the transcription request is abandoned (it runs on a watched thread), and the job fails at once, hold released, instead of running on until Docker's SIGKILL leaves it in `submitting` for the 10-minute sweep. |

### Opening it (the operator's checklist; nothing is sold until every step is done, in this order)

The entry ships **hidden**: no `credit_prices` row, no probe, no availability.

1. **Apply 0171.** It is live on apply when merged; it writes no row.
2. **Build and deploy the worker image** (`Dockerfile.worker`: Node, the engine, Remotion's Chrome, Inter and fontconfig, the
   effects, the warm render cache). `docker compose --profile worker build creative-worker`, then up.
3. **Measure one 600 s render's peak memory as uid 1000 in the built image**, with the deploy's own limits (`mem_limit`, the
   tmpfs), before anything is sold. For example, with a ten-minute narration on the media volume:
   `docker compose --profile worker run --rm creative-worker sh -c 'NIGHTSHIFT_VOICE_VIDEO_E2E=/app/media/<narration>.mp3 python -m unittest tests.test_voice_video_adapter.TheRealEngine; cat /sys/fs/cgroup/memory.peak'`
   (`docker stats` beside it works where `memory.peak` is missing). This makes ONE PAID Scribe call (about $0.033 for ten
   minutes) with the worker's key; `NIGHTSHIFT_VOICE_VIDEO_E2E=<narration>.mp3:<words>.json` passes a word track instead and
   calls nothing. Whisper no longer runs in this process, so the peak is the render's alone.

   One render plus three vendor jobs must fit in
   `mem_limit` (2 GB today). If they do not, lower `CREATIVE_WORKER_CONCURRENCY` (or raise `mem_limit`) in
   `deploy/docker-compose.yml` first. Before the engine rendered in chunks it was measured at about +2.2 GB for a 30 s
   recording and +3.8 GB for 121 s, which does NOT fit: do not open the model on an engine without chunked rendering.
4. **Check the Remotion licence.** Remotion's Free License is "for individuals and companies of up to 3 people"; anyone
   else needs a Company License (remotion.dev/docs/license/pricing, read 2026-11-14). The owner is a one-person company:
   Free License, $0 today. Re-check when the company has more than 3 people, or on Remotion 5.0.
5. **Check the ElevenLabs account** (owner steps; the transcription is a paid ElevenLabs call inside a product we sell):
   - (a) **The plan is Scale or higher.** ElevenLabs' OEM Terms §2.B (https://elevenlabs.io/oem-terms, "Last Updated: 28 February
     2025") do not let Free, Starter, Creator or Pro customers make the Services available inside a product they sell. This
     covers the existing text-to-speech too, not only this model.
   - (b) **Training use is off**: in the account's "Data use" settings, turn off the use of our content for training (Terms §4(i)).
     Customers' own recordings are sent there.
   - (c) **Which credits it draws**: on the account's usage page, check after one transcription whether speech-to-text draws from
     the same credit pool as text-to-speech (the official pricing pages disagree). If it does, transcription can starve the
     channels' narration: watch the balance, or keep a margin of credits for narration.
6. **Clear the terms gate** once (a) holds: the entry carries `"terms_gate": "plan_required:scale"`, and the database refuses to
   put a gated model on sale. A pull request that sets it to `null` in `schemas/model_registry.json`, merged and deployed. Whether
   the model should also be `web_only` (OEM Terms §2.B(a): no resale to a third party who will itself make the Service available;
   an API customer receives a rendered video, not Scribe) is the owner's decision; it is `any` today, as the MCP Studio tools offer it.
7. **Sync the registry** (`tools/probe_models.py --sync`, Actions → Probe models), so the database has the row.
8. **Probe it on the worker**, where the engine is: the probe proves that THIS machine renders and that ElevenLabs transcribes for
   this key, and the Actions runner has no engine (its probe answers `not_configured`, honestly). For example
   `docker compose --profile worker run --rm creative-worker python tools/probe_models.py --model nightshift-voice-explainer --voice-id <a voice of the account>`
   (two small paid calls: the probe speaks its words with ElevenLabs Flash, then Scribe transcribes them; then a local render).
9. **Apply the price**: `docs/sql/price_0171_voice_explainer.sql` in the SQL editor (owner decision 2026-11-14:
   `credits_per_unit` 0.05 per second of recording, the fully-loaded unit cost, margin 7.0, so 0.4 credits a second, 24 a
   minute; the derivation is in its header). It refuses while the model is unprobed, and refuses 0 or NULL: a zero row
   would make every voice video free, because `job_minimum` floors only a price above 0. The price covers Scribe's $0.20 an
   audio hour (about 0.33 credits a minute against 24 charged).
10. **Set its availability** (Models page).

### Capacity (a CPU and memory risk; deploy defaults unchanged)

Measured: the render runs at about 3.4 times real time on 4 cores (the owner's figure, 2026-11-14; the first single runs
were 80 s for a 30 s Uzbek narration with one Remotion worker on its own and 92 s through the adapter with the test suite
beside it), so a ten-minute recording is roughly half an hour of one core-heavy process. (The transcription now runs at ElevenLabs and
takes no CPU or memory on this machine.) The creative worker runs four jobs at once (`CREATIVE_WORKER_CONCURRENCY: "4"`,
`cpu_shares: 256`, `mem_limit: 2g`, `deploy/docker-compose.yml`).

So the worker renders **one voice video at a time per process**, and the slot is taken before the job is sent
(`SERIAL_CAPABILITIES`, `modules/creative_worker.py`). A second voice video that arrives meanwhile stays claimed but NOT
sent: its hold stays, its heartbeat keeps it alive, it can still be cancelled from the Studio, and the thread that claimed it
goes on running vendor jobs. It runs as soon as the slot is free; on a stop it is handed back to the queue (nothing charged,
the attempt not counted). A thread keeps at most 8 such jobs; past that it hands the claim back and pauses for 5 s.

Peak memory: see step 3 of the checklist; the numbers above are from before chunked rendering. The render's scratch lives in
the job's own folder on the media volume, never on the container's `/tmp` (a tmpfs, which counts against the memory limit),
and it is removed on every way out of the job; at start the worker removes input folders older than 24 hours that a crashed
worker left behind. Remotion's webpack cache is warmed at image build and is the one folder of `node_modules` uid 1000 can
write (`node_modules/.cache`), so a render does not bundle from scratch.

### The AI label

The video is drawn by our own code (Remotion) over the person's own recording; the words on screen are their words, read by
speech recognition (ElevenLabs Scribe: it transcribes, it makes nothing) and laid out by deterministic rules. No picture, frame or voice is made by a generative model.
That is the "Remotion graphics, captions" row of docs/AI_DISCLOSURE.md: no label. The library asset is still
`source = generated` (the platform made the file; that is who made it, not how) with provenance naming the capability, the model,
the provider `nightshift` and the source recording, so the decision can be revisited from the record. The Studio's note says
plainly that no AI image or video model draws it.

### Still not in this slice

- A model planner (Gemini) as its own priced, probed model.
- A language hint for the transcription: 0176's params refuse a `language`, so Scribe detects it. Naming `uz` / `ru` / `en`
  (as the captions job can) needs a later migration that allows the param; the adapter then sends it as `language_code`.
- Music beds: none is added (the generated placeholders are not good enough to sell). Real recordings dropped into
  `assets/music/` and a `music` param would be a later slice.
- Cancelling a job while it is rendering or being transcribed does not stop it (a stop of the worker does, at once).
- The fonts: Inter is installed in the worker image (`fonts-inter`); JetBrains Mono is not, so the numbers in a progress bar
  fall back to DejaVu Sans Mono, which the composition names as its second choice.
