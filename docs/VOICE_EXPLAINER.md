# Voice to 2D video (slice 1a: the engine; slice 1b: the Studio tool, migration 0176)

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
| Visual catalogue: `characters` (4 settings, 8 poses, 6 props), `card`, `stat`, `progress`, `emoji`, `checklist`, `chat`, `none` | `types.ts`, `Characters.tsx`, `Scenery.tsx`, `Visuals.tsx` |
| Motion as pure functions of time (blinks, mouth, pops, exits, push-in, hand-over) | `motion.ts` |
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
- `--music bed.mp3`, `--sfx-dir assets/sfx` (or `none`), `--no-captions`, `--no-media-card`,
  `--browser` (a Chrome; `CHRONOS_REMOTION_BROWSER`).

## What the picture does

- **Settings** are drawn as parallax layers: sky, a far skyline, the set, and the ground. The layers drift at
  different speeds, and the camera pushes in from 1.00 to 1.06 over each scene.
  - The street is a café at dusk: an awning, a sign drawn as a cup (no language in the art), lit windows with
    glow, wall lamps with light cones, and a street lamp.
  - The room has a window with the sky behind it, curtains, a shelf and a floor lamp.
  - The office has windows, ceiling lights, and desks with monitors.
  - The stage has curtains and three spotlights.
  - Dust drifts through the light in all four, and grain moves over the drawn scene.
- **People** have shoulders, and hair by colour slot, so the same person looks the same in every scene. They breathe.
  - They blink at seeded moments, 2 to 5 s apart.
  - Their brows follow the pose.
  - One person's mouth opens and closes while the narration's own words are being said, and is shut in the pauses.
  - Gestures ease in. `walk` walks in from the nearer edge, then stands. People turn toward each other.
  - Two people with a phone, coin or book hand it from the first to the second; the receiver reacts. It waits for a
    walk-in and lands at least 0.5 s before the scene ends.
- **A character scene is a video card**: the scene, a title row (the kicker, else the headline), and a thin line that
  grows through the scene. The line traces the word timings, so it swells where the voice speaks. It is not an audio
  waveform. `--no-media-card` draws the bare scene.
- **Text**:
  - The kicker slides in.
  - The headline arrives word by word out of a blur. Its starred word pops when the narration says it (matched in this
    scene's words, endings allowed for stems of four letters or more). When the narration never says it, it pops on
    its entrance.
  - The italic accent line blurs in as its first word is said, else 0.6 s in, and never later than 1 s before the
    scene ends.
  - Captions show four words, and the word being said lifts.
- **Cuts**: a scene leaves in its own last 7 frames (fade, blur, slight rise). It never takes more than a third of a
  short scene, and the last scene does not leave. A transition never lengthens a scene, so the picture cannot run
  past the narration. The backdrop never cuts.
- Everything is a function of the frame (`motion.ts`, an integer hash, no `Math.random` or clock). Separate render
  processes therefore agree frame for frame.

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

## Rendering: one bundle, chunks for long videos

`render()` bundles the project once (`remotion bundle`, in its own short process) and renders from the bundle.

- **Up to 60 s** (two chunks' worth): one render, sound included, as before.
- **Longer**: the picture is rendered in chunks of at least 30 s each (`CHUNK_S`). A chunk only ends where a scene
  starts (`plan_chunks`, rounded half-up like the composition), so no scene is split between two browser processes.
  - The chunks are rendered muted (`--frames=a-b --muted`).
  - The sound is rendered once, over the whole timeline, as lossless WAV. It uses the same composition with
    `sound_only` set: the same `<Audio>` elements at the same frames and volumes, with nothing drawn.
  - Measured on a 12 s cut, that sound is bit-identical to a single render's (576016 samples, every one equal).
  - Remotion still visits every frame to collect the sound: 63 s on the 121 s input with one tab. With nothing drawn,
    the pass runs in up to 4 tabs (`SOUND_TABS`, never more than the cores). On the 30 s demo that took it from
    20.4 s to 10.4 s at 448 MB PSS, with byte-identical output. The picture chunks keep one tab each, for memory.
  - ffmpeg joins the pictures without re-encoding and encodes the sound once, as a single render does (AAC, 320
    kb/s, 48 kHz).
  - A joined file whose frame count is not the composition's is refused and deleted.
- **Two designs that were measured and dropped**:
  - **Each chunk writing its own sound** (`--separate-audio-to`). Remotion mixes a sound effect that has started
    before a chunk, or starts on its first frame, differently from a whole render. That happens to the whoosh at every
    cut: up to 0.7 s of wrong sound after each seam, and 16 extra samples at the end of the first chunk.
  - **An audio-only render of the full composition** (`--codec=aac`). It still draws every frame in the browser: 98 s
    on the 121 s input.
  - A sound rebuilt in ffmpeg from the narration, music and effects was not tried; it would only approximate
    Remotion's mix.
- **Licence**: Remotion counts every successful render (a still or a video) as one render. A video under 60 s is 1
  render. A longer one is its picture chunks plus the sound pass: 3 or 4 chunks plus 1 for two minutes, depending on
  where its scenes start. Chunks are never shorter than 30 s, to keep that count low.

## Measured

Measured on a 4-core cloud container at 1080×1920, 30 fps, one Remotion worker. Memory is the process tree's PSS
(shared pages counted once), sampled every 0.5 s. Time is the whole command's wall time.

| Input | Before (single render, old look) | After (new look, bundle once, chunks) |
| :-- | :-- | :-- |
| 30 s demo (54 words, 8 scenes): one render | 94.1 s, peak 1442 MB | 114.9 s (1.22×) final code on a quiet machine; 141.2 s (1.50×) at worst while shared; peak 1201–1253 MB |
| 121 s (216 words): 4 picture chunks + 1 sound pass | 320.1 s, peak 1464 MB | 540.6 s (1.69×), peak 1245 MB |

- **The "after" times are a range** because the container is shared. The 114.9 s run was quiet. The slower runs
  overlapped another job's test suite (load average about 4.5 on 4 cores).
- **The 121 s render**: four picture chunks at 115–130 s each, then the sound pass in 20 s with 4 tabs (63 s with 1),
  then the join in under a second.
- **The time is the price of the new picture**: about 0.12–0.15 s a frame against 0.085 s before. The chunking and
  the sound pass add about 25 s on two minutes.

What the memory is, at the peak:
- **ffmpeg's x264: about 580 MB**, the same at every length.
- **The CLI's node process: about 450 MB** while it held the webpack bundle. It is about 105 MB once the bundle is a
  separate step.
- **Chrome: 330–530 MB**, creeping during a render. Chunks restart it every 30 s or more.

Peak memory did not grow with the recording's length: 30 s and 121 s peaked within 25 MB of each other. The earlier
"+2.2 GB / +3.8 GB" figures were not reproduced by a process-tree measure; they likely counted page cache. Chunking
bounds the browser's creep and keeps every process short. The fixed cost is the encoder.

Against the Studio creative worker's 2 GB limit, the peak is about 1.25 GB PSS. The sum of RSS, which double-counts
Chrome's shared pages, is about 1.7 GB. A cgroup also charges page cache, and that was not measured here. The next
lever, if a worker needs more headroom, is the encoder: an x264 preset with a shorter lookahead. That trades file
size for memory, and it was not changed in this slice.

The new look costs render time. A full-frame overlay is paid on every frame in the render's software compositor: a
5%-opacity grain over the whole frame added about 0.035 s a frame. So the grain covers only the drawn scene, as one
noise tile moved by a transform, and the vignette is part of the backdrop.

The mixed audio's mean level was -24.9 dB against the narration's -23.7 dB, so the music does not drown the voice
(measured on the first version; the mix is unchanged).

## Slice 1b: "Voice to video" in the Studio (migration 0176)

A person picks one of their library recordings (their own narration, audio only, at most 600 s) and one of the five looks on
the Studio's **Voice** desk, sees the database's price, and presses Generate. The creative worker draws the video on this
server with the engine above and stores it in the media library. It is an ordinary creative job: quote, hold, capture, and
a full release on every failure (`create_creative_job`, 0036; nothing new in the money path). The MCP Studio tools
(`list_models`, `quote_generation`, `create_generation`, `get_generation`) offer it too, with the same params.

| Part | Where |
| :-- | :-- |
| The capability `voice_explainer`: params, source, price, the CHECKs, the API's list | `supabase/migrations/0176_voice_video.sql` (rollback: `docs/sql/rollback_0176_voice_video.sql`) |
| The adapter (our own engine, no vendor) | `modules/capabilities/voice_video.py` (`video.voice_explainer`) |
| The registry entry (ships dark) | `schemas/model_registry.json` `nightshift-voice-explainer` (vendor model `voice-explainer-rules-1`) |
| The worker's lists and its one render slot | `modules/creative_worker.py` (`SOURCE_` / `MEDIA_SOURCE_` / `AUDIO_SOURCE_` / `SERIAL_CAPABILITIES`, `OUTPUT_KIND`) |
| The price (owner-applied, after the probe) | `docs/sql/price_0176_voice_explainer.sql` |
| The Studio tool | `command-center/lib/creative/{operations,studio,desks}.ts`, `components/studio/GeneratePanel.tsx` (Voice desk) |
| The worker image | `Dockerfile.worker`: Node 22, the engine (`npm ci`), Remotion's headless Chrome, its Debian libraries, Inter and fontconfig, the effects, a warm render cache |

### What the database decides (0176)

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
recording that was sold, and the job is refused before Whisper runs. Then
`transcribe` (local Whisper `base`, `SubtitleGenerator.transcribe`) → `fit_words` → `split_sentences` → `plan_rules` →
`build_scenes` → `sound_cues` → `build_props` → `render`, exactly as `tools/voice_to_video.py --planner rules` does. **The rules planner only**: deterministic, free, offline. No Gemini call is made inside a paid job:
a model planner would be a second provider whose failure the person's hold pays for. It is a later slice with its own
vendor model (`voice-explainer-model-…`), probe and price; the adapter refuses any vendor model but `voice-explainer-rules-1`.

The adapter is synchronous: the render happens inside `submit`, and the finished file is handed to the worker by its path (a
ten-minute video is hundreds of MB; it is moved, never read into memory). Like every synchronous adapter, a worker that restarts
between the render and the store has lost it: the job fails `output_lost` and the hold is released in full (nothing is charged,
nothing is rendered twice).

No silent fallback anywhere (CLAUDE.md rule 4). Every refusal fails the job, releases the hold, and names its fix:

| What | Code | Why it is not something else |
| :-- | :-- | :-- |
| The engine is not installed on this worker (no `npx`, `ffmpeg` or `ffprobe`, no `npm ci` in `video-engine/`, Remotion's browser not downloaded or a `CHRONOS_REMOTION_BROWSER` that is not a file, no Whisper or its model, no effects, fontconfig not answering `Inter`) | `not_configured` | Checked before anything runs; it is also what `configured()` (and so the probe) reads. Never key-based: there is no key. Without Inter, Chrome would set the words in another face. |
| The recording does not decode as sound, decodes to a length more than 1 s from the library's, is longer than 600 s, or has no words | `bad_request` | The person's fix. "No words" is never a silent or captionless video. |
| The decoded copy cannot be measured | `bad_response` | The worker just wrote it: this machine's failure, not the recording's. |
| The word track does not belong to the recording | `bad_request` | `fit_words` refuses it before the render. |
| The transcription crashed | `bad_response` | The engine's failure, never reported as "no words". |
| Remotion failed | `bad_response` | Its log tail goes to the operator's log only: it names this machine's paths. |
| The render ran out of time (600 s + 6 s per second of narration) | `unavailable` | A busy machine: try again later. |
| The worker was told to stop (SIGTERM) during the job | `unavailable` | The render's process group is killed and the job fails at once, hold released, instead of rendering on until Docker's SIGKILL leaves it in `submitting` for the 10-minute sweep. |

### Opening it (the operator's checklist; nothing is sold until every step is done, in this order)

The entry ships **hidden**: no `credit_prices` row, no probe, no availability.

1. **Apply 0176.** It is live on apply when merged; it writes no row.
2. **Build and deploy the worker image** (`Dockerfile.worker`: Node, the engine, Remotion's Chrome, Inter and fontconfig, the
   effects, the warm render cache). `docker compose --profile worker build creative-worker`, then up.
3. **Measure one 600 s render's peak memory as uid 1000 in the built image**, with the deploy's own limits (`mem_limit`, the
   tmpfs), before anything is sold. For example, with a ten-minute narration on the media volume:
   `docker compose --profile worker run --rm creative-worker sh -c 'NIGHTSHIFT_VOICE_VIDEO_E2E=/app/media/<narration>.mp3 python -m unittest tests.test_voice_video_adapter.TheRealEngine; cat /sys/fs/cgroup/memory.peak'`
   (`docker stats` beside it works where `memory.peak` is missing). One render plus three vendor jobs must fit in
   `mem_limit` (2 GB today). If they do not, lower `CREATIVE_WORKER_CONCURRENCY` (or raise `mem_limit`) in
   `deploy/docker-compose.yml` first. Before the engine rendered in chunks it was measured at about +2.2 GB for a 30 s
   recording and +3.8 GB for 121 s, which does NOT fit: do not open the model on an engine without chunked rendering.
4. **Check the Remotion licence.** Remotion's Free License is "for individuals and companies of up to 3 people"; anyone
   else needs a Company License (remotion.dev/docs/license/pricing, read 2026-11-14). The owner is a one-person company:
   Free License, $0 today. Re-check when the company has more than 3 people, or on Remotion 5.0.
5. **Sync the registry** (`tools/probe_models.py --sync`, Actions → Probe models), so the database has the row.
6. **Probe it on the worker**, where the engine is: the probe proves that THIS machine renders, and the Actions runner has no
   engine (its probe answers `not_configured`, honestly). For example
   `docker compose --profile worker run --rm creative-worker python tools/probe_models.py --model nightshift-voice-explainer --voice-id <a voice of the account>`
   (the probe speaks its words with ElevenLabs Flash first: one small paid TTS call, as for every voice tool's probe).
7. **Apply the price**: `docs/sql/price_0176_voice_explainer.sql` in the SQL editor (owner decision 2026-11-14:
   0.4 credits a second, 24 a minute; priced from credit_prices; see the owner's private pricing notes. Fill in its two NULL figures from those notes first). It refuses while the model is unprobed, and refuses 0 or NULL: a zero row
   would make every voice video free, because `job_minimum` floors only a price above 0.
8. **Set its availability** (Models page).

### Capacity (a CPU and memory risk; deploy defaults unchanged)

Measured: the render runs at about 3.4 times real time on 4 cores (the owner's figure, 2026-11-14; the first single runs
were 80 s for a 30 s Uzbek narration with one Remotion worker on its own and 92 s through the adapter with the test suite
beside it), so a ten-minute recording is roughly half an hour of one core-heavy process. The creative worker runs four jobs at once (`CREATIVE_WORKER_CONCURRENCY: "4"`,
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
- Cancelling a job while it is rendering does not stop the render (a stop of the worker does); a stop during Whisper's
  transcription waits for it (it runs in this process), up to Docker's 60 s grace.
- The fonts: Inter is installed in the worker image (`fonts-inter`); JetBrains Mono is not, so the numbers in a progress bar
  fall back to DejaVu Sans Mono, which the composition names as its second choice.
