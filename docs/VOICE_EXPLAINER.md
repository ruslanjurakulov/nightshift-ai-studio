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

Everything a run needs is checked before the slow parts. A failure says what to do:
- the recording must exist, be readable and be at most 600 s;
- the look must exist;
- the engine must be installed;
- the effects must be present;
- with `--planner model`, a key must be set.

## Measured

A 30 s Uzbek narration (54 words, 8 sentences) rendered to 1080×1920 at 30 fps in 80 s
with one Remotion worker, in a 4-core cloud container. The mixed audio's mean level was
-24.9 dB against the narration's -23.7 dB, so the music does not drown the voice.

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
