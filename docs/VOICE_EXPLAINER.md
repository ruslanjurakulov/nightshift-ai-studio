# Voice to 2D video (slice 1a: the engine)

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

## Not in this slice (next: 1b)

- **Not a run kind yet.** No credit hold, no queue job, no customer upload, no publish.
  It spends nothing of a customer's. The product slice adds:
  - a `render_jobs` kind or params carrying an uploaded audio `asset_id` (migration,
    `render_job_params_valid`);
  - pricing by recording length;
  - the worker path;
  - the create form and the MCP tool field.
- **The worker image has no Node or Chromium** (`Dockerfile.worker` says so). The product
  slice installs them and the Inter font. Until then the faces fall back to DejaVu, the
  fonts the worker ships.
- Whisper runs on the mixed audio in the daily pipeline; here it runs on the clean
  narration. A language hint for Whisper is a 1b item.
- The music and effects are the generated placeholders (`tools/generate_assets.py`).
  Real recordings dropped into `assets/` replace them.
