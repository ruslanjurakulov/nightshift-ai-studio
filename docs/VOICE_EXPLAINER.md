# Voice to 2D video (slice 1a: the engine; slice 1b: the Studio tool, migration 0170)

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

## Slice 1b: "Voice to video" in the Studio (migration 0170)

A person picks one of their library recordings (their own narration, audio only, at most 600 s) and one of the five looks on
the Studio's **Voice** desk, sees the database's price, and presses Generate. The creative worker draws the video on this
server with the engine above and stores it in the media library. It is an ordinary creative job: quote, hold, capture, and
a full release on every failure (`create_creative_job`, 0036; nothing new in the money path). The MCP Studio tools
(`list_models`, `quote_generation`, `create_generation`, `get_generation`) offer it too, with the same params.

| Part | Where |
| :-- | :-- |
| The capability `voice_explainer`: params, source, price, the CHECKs, the API's list | `supabase/migrations/0170_voice_video.sql` (rollback: `docs/sql/rollback_0170_voice_video.sql`) |
| The adapter (our own engine, no vendor) | `modules/capabilities/voice_video.py` (`video.voice_explainer`) |
| The registry entry (ships dark) | `schemas/model_registry.json` `nightshift-voice-explainer` (vendor model `voice-explainer-rules-1`) |
| The worker's lists | `modules/creative_worker.py` (`SOURCE_` / `MEDIA_SOURCE_` / `AUDIO_SOURCE_CAPABILITIES`, `OUTPUT_KIND`) |
| The Studio tool | `command-center/lib/creative/{operations,studio,desks}.ts`, `components/studio/GeneratePanel.tsx` (Voice desk) |
| The worker image | `Dockerfile.worker`: Node 22, the engine (`npm ci`), Remotion's headless Chrome, its Debian libraries, Inter, the effects |

### What the database decides (0170)

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

`transcribe` (local Whisper `base`, `SubtitleGenerator.transcribe`) → `fit_words` → `split_sentences` → `plan_rules` →
`build_scenes` → `sound_cues` → `build_props` → `render`, on the copied recording, exactly as `tools/voice_to_video.py
--planner rules` does. **The rules planner only**: deterministic, free, offline. No Gemini call is made inside a paid job:
a model planner would be a second provider whose failure the person's hold pays for. It is a later slice with its own
vendor model (`voice-explainer-model-…`), probe and price; the adapter refuses any vendor model but `voice-explainer-rules-1`.

The adapter is synchronous: the render happens inside `submit`, and the finished file is handed to the worker by its path (a
ten-minute video is hundreds of MB; it is moved, never read into memory). Like every synchronous adapter, a worker that restarts
between the render and the store has lost it: the job fails `output_lost` and the hold is released in full (nothing is charged,
nothing is rendered twice).

No silent fallback anywhere (CLAUDE.md rule 4). Every refusal fails the job, releases the hold, and names its fix:

| What | Code | Why it is not something else |
| :-- | :-- | :-- |
| The engine is not installed on this worker (no `npx`, no `npm ci` in `video-engine/`, no Whisper or its model, no effects, a `CHRONOS_REMOTION_BROWSER` that is not a file) | `not_configured` | Checked before anything runs; it is also what `configured()` (and so the probe) reads. Never key-based: there is no key. |
| The recording is longer than 600 s, unreadable, or has no words | `bad_request` | The person's fix. "No words" is never a silent or captionless video. |
| The word track does not belong to the recording | `bad_request` | `fit_words` refuses it before the render. |
| The transcription crashed | `bad_response` | The engine's failure, never reported as "no words". |
| Remotion failed | `bad_response` | Its log tail goes to the operator's log only: it names this machine's paths. |
| The render ran out of time (600 s + 6 s per second of narration) | `unavailable` | A busy machine: try again later. |

### Opening it (the operator; nothing is sold until all four are done)

The entry ships **hidden**: no `credit_prices` row, no probe, no availability. To sell it, in order:

1. Apply 0170 (it is live on apply when merged) and deploy the worker image (Node, the engine, Chrome, Inter, the effects).
2. `tools/probe_models.py --sync` (Actions → Probe models), so the database has the row.
3. Probe it **on the worker**, where the engine is: the probe proves that THIS machine renders, and the Actions runner has no
   engine (its probe answers `not_configured`, honestly). For example
   `docker compose --profile worker run --rm creative-worker python tools/probe_models.py --model nightshift-voice-explainer --voice-id <a voice of the account>`
   (the probe speaks its words with ElevenLabs Flash first: one small paid TTS call, as for every voice tool's probe).
4. Set its availability (Models page) and its credit price (Credits page, unit `model_nightshift_voice_explainer_second`).
   There is no vendor price to start from: the cost is this server's CPU (below).

### Capacity (a CPU risk; deploy defaults unchanged)

Measured once: a 30 s Uzbek narration rendered to 1080×1920 at 30 fps in 80 s with one Remotion worker on 4 cores (the
operator command), and 92 s through the adapter with the Python test suite running beside it. So about 3 s of render per
second of narration; a ten-minute recording is roughly half an hour of one core-heavy process. The creative worker runs four
jobs at once (`CREATIVE_WORKER_CONCURRENCY: "4"`, `cpu_shares: 256`, `mem_limit: 2g`, `deploy/docker-compose.yml`). The adapter
therefore renders **one voice video at a time per worker process** (a lock): a second one waits (its hold stays, its heartbeat
keeps it alive), and vendor jobs keep running on the other threads. Peak memory of one render inside the 2 GB limit was NOT
measured (no Docker daemon where this was built): measure it on the server before opening the model, and lower the creative
worker's concurrency if one render and three vendor jobs do not fit (`max_concurrent_per_org` is already 1). The render's scratch lives in the job's own folder
on the media volume, never on the container's `/tmp` (a tmpfs, which counts against the memory limit).

### The AI label

The video is drawn by our own code (Remotion) over the person's own recording; the words on screen are their words, read by
speech recognition (Whisper) and laid out by deterministic rules. No picture, frame or voice is made by a generative model.
That is the "Remotion graphics, captions" row of docs/AI_DISCLOSURE.md: no label. The library asset is still
`source = generated` (the platform made the file; that is who made it, not how) with provenance naming the capability, the model,
the provider `nightshift` and the source recording, so the decision can be revisited from the record. The Studio's note says
plainly that no AI image or video model draws it.

### Still not in this slice

- A model planner (Gemini) as its own priced, probed model.
- A language hint for Whisper (it detects the language; Uzbek on `base` is the weakest of the three).
- Music beds: none is added (the generated placeholders are not good enough to sell). Real recordings dropped into
  `assets/music/` and a `music` param would be a later slice.
- The fonts: Inter is installed in the worker image (`fonts-inter`); JetBrains Mono is not, so the numbers in a progress bar
  fall back to DejaVu Sans Mono, which the composition names as its second choice.
