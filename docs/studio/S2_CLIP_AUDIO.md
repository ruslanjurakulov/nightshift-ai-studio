# S2: a Film Studio clip's own sound in the master (measurement, no fix)

Rule 8 deliverable: evidence, then diagnosis, then a proposal. Nothing here changes behaviour, nothing was
spent, no vendor was called. Every number comes from `tools/clip_audio_measure.py` run locally with
ffmpeg 6.1.1 (command in §11), or from a file:line on `main` at 948c2f31c.

Scope, as updated by Atlas on 28 Nov: the owner's 14 reference reels were analysed. 10 of 14 are carried by
in-clip lip-synced dialogue (Uzbek, Russian, English), all 14 have foley and music, and 3 are wordless
slapstick carried by sound effects. S1 keeps in-clip dialogue as a per-scene mode. So "clip sound" means
**dialogue and ambience**, and dropping it is the program's first gap. The design target here is a 90 s film
of 26 to 34 shots of about 3 s at 1080p; it was measured with 30 shots of 3 s.

## 0. Short answers

1. **Where the sound is lost.** In `modules/film_timeline.py`, not in the renderer. `build_cut` writes every
   picture clip without `"audio": true` (`film_timeline.py:459-460`), and the editor's sound for a picture
   clip is opt-in (`timeline.py:257`). The `-an` flags in `render_backend.py` are on the picture
   intermediates only. By design, the sound is read again from the source files in the final pass, so they
   do not drop sound by themselves.
2. **Measured.** On a 90 s 1080p film with 25 clips that carry a tone, today's master has the clip tone at
   the noise floor: -68.9 LUFS in its band, against -21.1 LUFS in the source clip. The in-clip dialogue
   tone is not measurable at all ("no signal"). The narration is at -16.5 LUFS and the music at -36.1 LUFS.
   The master is -16.6 LUFS integrated, -14.5 dBTP, AAC 48 kHz stereo at about 118 kb/s.
3. **The editor can already carry it.** With `audio: true` on every picture clip (what the unmerged branch
   `vera/film-clip-audio` does), the same film renders. The final pass has **35 inputs**, above the
   32-clip ceiling `film_timeline` enforces. At 1080p under the 2 GiB limit it finished in 95 s at
   641 MB. But the music then ducks under the **whole film**, one span 0.0 to 89.25 s, even in the wordless
   scene.
4. **A one-stem premix fits.** 25 clips' sound was premixed into one file with the editor's own chains, 20
   acrossfades included. On 2 cores it took **1.07 s and 121 MB**. The final pass then has 11 inputs
   instead of 35, and took 86 s instead of 95 s.
5. **There is no master loudness pass today**, and the plan says so (`film_timeline.py:632`). A two-pass
   `loudnorm` with `linear=true` at -14 LUFS, -1 dBTP and LRA 11 **falls back to dynamic mode on today's
   master** (its measured LRA is 14.0). The proposed mix measured LRA 5.0 and took the linear path, ending
   at -13.9 LUFS and -8.6 dBTP. So "fail by name on dynamic" is the right guard, but its LRA target has to
   be chosen (§7.4).
6. **Intelligibility.** In the proposed mix, a dialogue scene's speech is **27.5 dB above the music** after
   ducking (-16.6 against -44.1 dB, band RMS). A narrated scene's narration is 18.0 dB above the ducked
   ambience and 27.3 dB above the music.

## 1. Which stage drops the sound: the film path end to end

| Step | File:line | What happens to a clip's sound |
| :-- | :-- | :-- |
| Take result | `modules/media_library.py:1449` (`store_generated` → `copy_and_hash`) | The provider's file is stored **byte for byte** as the `original` variant, sound included. |
| Library proxy | `media_library.py:799-809` | The 480p review proxy keeps the first audio stream (`-map 0:a:0?`, AAC 96k). |
| Last frame | `modules/film_orchestrator.py:296` | `-an` on a one-PNG extraction. **Intended**: a picture has no sound. |
| Assembly | `modules/film_assembly.py:807` | The resolver probes `has_audio` on every video (`editor_export.probe_has_audio`, `editor_export.py:276-290`, which raises rather than guess). |
| Cut | `modules/film_timeline.py:459-460` | The V clip is `{id, asset_id, start_s, in_s, out_s, fit}`. **There is no `audio` key, so the clip's sound is not asked for. This is where the sound is dropped.** |
| Cut, sound | `film_timeline.py:539`, `:561-564` | The A tracks are the narration (role `speech`) and the music (role `music`, ducked). Nothing else. |
| Cut, count | `film_timeline.py:569-574` | `MAX_SOUND_CLIPS` counts A-track clips only. |
| Spec | `modules/timeline_render.py:284-320` (`_sound`) | A V clip becomes an `AudioTrack` only when `audio` is true **and** its file is known to carry sound (`has_audio is True`). Otherwise it is silent, never an error. |
| Picture segments | `modules/render_backend.py:768` (video), `:954`, `:973` (xfade) | `-an`. **Intended**: segments are picture-only intermediates; sound is mixed in the final pass from the source files. |
| Stabiliser pre-pass | `render_backend.py:840` | `-an` on a `vidstabdetect` analysis to `-f null`. **Intended.** |
| Video overlay | `modules/render_spec.py:1567` | `-an`: "an overlay is never heard" (documented contract). **Intended.** |
| Final mux | `render_spec.py:1781` (`amix normalize=0`), `:1791` (`-c:a aac`) | Every AudioTrack is one `-i` input, then `aformat` 48 kHz stereo fltp (`:1480`), `amix` and AAC at the encoder's default bitrate. |
| Output check | `film_assembly.py:833-840` | `wants_sound` is true only when an A track has clips. A film whose only sound is its clips would pass with **no audio stream**. |

Other `-an` in the repo, none of them on a film's sound path: `scene_render.py:372` and
`scene_remotion.py:269` (picture intermediates of the pipeline's scene renders), `video_qc.py:407`
(analysis of a file with no audio stream), `tools/probe_models.py:223`, `tools/export_showcase.py:583-584`
(public showcase copies keep sound only when the manifest says `audio`), and
`tools/film_assembly_measure.py:122` (synthetic silent clips).

**The non-film pipeline, for comparison.** Clip sound is dropped on purpose. `modules/compositor.py:180`
opens stock footage with `VideoFileClip(..., audio=False)`; the comment there names the memory death of run
#19, where each source cost two ffmpeg decoders. The presenter overlay calls `.without_audio()` (`:404`).
The only soundtrack is the pydub narration and music mix (`audio_mixer.py`, music per cue from -6 to
-22 dB, `:45-51`, exported as MP3 192k). The ffmpeg path (`render_spec.py:1390-1397`) muxes that one file
with `-c:a aac -shortest`. Neither path has a loudness pass on the master.

## 2. What each clip actually carries

### 2.1 The registry (`schemas/model_registry.json`, the source the migrations sync)

`audio_out` says whether a model can return sound. `pricing.variants.by` says whether the sound is priced
apart. Vendor prices are not quoted here. The credit unit that `creative_price` resolves is
`<credit_unit>_<resolution>_<silent|audio>` (`supabase/migrations/0224_dated_credit_price.sql:607-628`).

| Sound | Models (video t2v/i2v) | What a take gets |
| :-- | :-- | :-- |
| **Priced apart** (`by: audio` / `resolution_audio`) | `kling-v3` (`silent`/`audio`), `seedance-1.5-pro` (`<res>_silent`/`<res>_audio`) | Only these accept `clip_params.audio` (0224:601-605 refuses it on any other model). No `audio` = the **silent** price, and the adapter sends sound off (`creative_adapters.py:210-221`: a priced variant missing from the job fails before the call). |
| **Sound inside one price** (`audio_out: true`, `by: resolution`) | `veo-3.1`, `-fast`, `-lite`; `minimax-h3`, `-highspeed`, `-lite`, `-max`; `seedance-2.0`, `-2.5`; `happyhorse-1.1`; `grok-imagine-video-1.5`, `-lite`; `ltx-2.5-pro`, `-fast`, `ltx-2.3-pro`, `-fast`; `gemini-omni-1.1-flash`; `vidu-q3-pro`, `-turbo`, `-pro-fast`, `vidu-q4-preview` | No audio flag reaches the quote. Where the adapter has one (`ltx.py:117`, `xai.py:127`, `vidu.py:147`, `video.py:918/1095` Seedance), `request.audio` stays None, so the vendor's default applies; the adapters' comments say that default is "true on the vendor's side". Gemini Omni's soundtrack "is always on" (`google_interactions.py:257-258`). H3 is sent no flag (`minimax.py:22`). **These clips are expected to carry sound already, paid inside the one price, and the film drops it.** Not measured on a real file in this repo (§2.3). |
| **No sound** (`audio_out: false`) | `kling-v2.6`, `minimax-hailuo-2.3`, `runway-gen4.5`, `-gen4-turbo`, `luma-ray-3.2`, `seedance-1.0-pro`, `wan-2.7`, `wan-3.0`, `flux-3-video`, `pika-2.5`, `pika-pikaframes` | Silent file, or a file whose audio stream is digital silence (not measured). |

The film quote copies `clip_params.audio` into each clip line only when the scene set it
(`0171_films_money.sql:760`), so it is on the take's `params` too. 0166 (`:1043`) says: "Our narration is
the soundtrack, so a clip's own audio is a choice a person makes, never a default." **A person can set it
only on `kling-v3` and `seedance-1.5-pro`.**

### 2.2 Our adapters and library

- No adapter re-encodes a result. `SafeResultMixin` (`capabilities/safe_fetch.py:173`) downloads the bytes.
  The only ffmpeg call under `capabilities/` is a probe (`video.py:693-715`, Runway upscale).
- The library keeps the original and the proxy with sound (§1).
- Whether a file carries sound is **not stored**. It is probed at assembly time (`film_assembly.py:807`).

### 2.3 Sample files in the repo (ffprobe)

- The 35 `command-center/components/site/showcase/*/clip.mp4` files are real model outputs (minimax-h3 x13,
  -max x8, -lite x3, -highspeed x3, runway-gen4.5 x6, -gen4-turbo x2). **All have no audio stream.** That is
  not evidence about the vendors: `tools/export_showcase.py:583-584` writes `-an` unless the manifest
  entry has `audio`, and none of these entries has it. Several prompts ask for sound ("the blade crunches
  through with crisp crackling", `bf349995`), but our copy cannot show whether H3 made it.
- `command-center/public/showcase/language-duo.mp4` and `templates/language-duo-podcast/preview.mp4`: AAC
  32 kHz stereo, -10.8 LUFS. These are edited marketing previews with no model provenance, so they are not
  evidence either.
- `docs/design/s5-brand-intro/intro-1440x900.mp4`: AAC 48 kHz stereo, -18.9 LUFS (a designed intro).
- **No raw clip-model file with sound exists in the repo.** The loudness of a real Kling, H3 or Veo
  clip's own sound is unknown (§8).

## 3. How the master is mixed today

| Element | Value | Where |
| :-- | :-- | :-- |
| Narration | One take normalised by a gain to **-16 LUFS / -1.5 dBTP**, from its measured `loudness_lufs` and `true_peak_db`; within ±1 LU it is used as is; when not measured it is "not measured", gain 0 | `film_timeline.py:131-133`, `:317-338` |
| Music | **-18 dB** gain (`MUSIC_GAIN_DB_DEFAULT`), fades 1 s in, 1.5 s at joins, 3 s out | `film_timeline.py:143-147` |
| Ducking | Music ducked **-12 dB** (`DUCK_DB_DEFAULT`). Attack 0.3 s, release 0.8 s (`timeline.DUCK_DEFAULTS`). It is a deterministic `volume` envelope over the speech spans, merged when the gap is under attack + release. **Not a sidechain**: `render_spec.py:74-77` says a compressor "lowers by a ratio of whatever the speech level happens to be". | `timeline.py:366`, `render_spec.py:1495-1523`, `timeline_render.py:329-340` |
| What counts as speech for the duck | Every A clip on a `speech` track **and every V clip with `audio: true`** | `timeline.py:1757-1773` |
| Clip sound | none (§1) | |
| Mix | `amix normalize=0` (no 1/n division), `apad`, `atrim` to the picture | `render_spec.py:1741-1782` |
| Format | every input `aformat` fltp, **48 kHz, stereo**; AAC at ffmpeg's default (measured 118-128 kb/s) | `render_spec.py:1480`, `:1791` |
| Master loudness | **none**: the plan says "not normalised: the editor has no master loudness pass" | `film_timeline.py:632` |

## 4. Measured: a 90 s, 30-shot film at 1080p on 2 cores

**Set-up** (`tools/clip_audio_measure.py`, run under `taskset -c 0,1`, the runner's 2 cores; every
ffmpeg under `ffmpeg_limits`, 2 GiB):

- 30 scenes of 3 s, one shot each, cross-fades between scenes, captions off.
- Each source has its own tone, so the master can be read source by source with a narrow band-pass:
  - ambience 1000 Hz in every sounding clip, AAC 44.1 kHz stereo, -21.1 LUFS;
  - in-clip dialogue 2000 Hz bursts in the dialogue clips (with the ambience, -12.8 LUFS together);
  - narration 300 Hz, one mono WAV on the film's clock, -16.6 LUFS / -12.0 dBTP;
  - music 120 Hz, stereo WAV, -13.5 LUFS before the film's -18 dB.
- Scene roles:

  | Role | Scenes | Picture clip's sound | Narration |
  | :-- | :-- | :-- | :-- |
  | narrated | 17 | ambience | yes |
  | dialogue | 7, every `i % 4 == 3` | ambience + dialogue | none |
  | wordless | 1, scene 3 | ambience | none |
  | silent file | 5 | **no audio stream** | yes |

- The real `build_cut` gives 30 V clips, 8 narration clips and 1 music tile: 9 sound clips of 32.

### 4.1 The three documents, rendered through the real editor path

| | `as_is` (today) | `clip_audio` (what-if: `audio: true` on every V clip; vera's approach) | `stem` (what-if: the premix on one A track) |
| :-- | :-- | :-- | :-- |
| Final-pass inputs (`-i`) | 10 | **35** | 11 |
| AudioTracks / amix inputs | 9 / 9 | 34 / 14 (acrossfade runs) | 10 / 10 |
| Final pass wall time / peak RSS | 92.2 s / 546 MB | 95.0 s / 641 MB | 86.5 s / 546 MB |
| Whole render (59 segments + final) | 157.0 s (budget 390 s) | 159.6 s | 153.2 s |
| Master integrated / true peak | -16.6 LUFS / -14.5 dBTP | -14.9 / -10.4 | -14.9 / -9.6 |
| Ambience band in master | **-68.9 LUFS (noise floor)** | -20.1 | -20.1 |
| Dialogue band in master | **no signal** | -12.6 | -12.6 |
| Narration band | -16.5 | -16.5 | -16.5 |
| Music band | -36.1 | -43.6 | -36.1 |
| Music duck spans | 8 (narration) | **1: 0.0 to 89.25 s** | 8 (the stem track has no role) |

Per scene, band RMS in dB, in the middle of the scene's speech window:

| Scene (role) | Source | as_is | clip_audio | stem |
| :-- | :-- | --: | --: | --: |
| 2 (narrated) | narration / ambience / music | -18.2 / -67.2 / -45.4 | -18.2 / -24.1 / -45.4 | -18.2 / -24.1 / -45.4 |
| 3 (wordless) | ambience / music | -89.9 / **-33.3** | -24.1 / **-45.3** | -24.1 / -33.3 |
| 4 (dialogue) | dialogue / ambience / music | **-93.3** / -89.9 / -33.3 | -17.8 / -21.1 / -45.3 | -17.8 / -21.1 / **-33.3** |
| 5 (silent file) | ambience / narration | -67.2 / -18.1 | -72.3 / -18.1 | -72.3 / -18.1 |

What the table shows:

- **Today** the dialogue scene has no speech at all (-93.3 dB), and the music plays unducked over the
  place the lines should be.
- **`audio: true`** brings the sound back. It costs 25 more inputs, and it ducks the music everywhere: the
  wordless scene's music is -45.3 instead of -33.3, because `speech_spans` treats every sounding V clip as
  speech. On a slapstick reel, the music would never come up.
  - The ambience under the narration is not ducked: it is 5.9 dB under the narration (-24.1 against
    -18.2).
  - A clip with no audio stream is silent and does not fail. Its band stays at the floor (-72.3), and no
    sound is invented.
- **The stem** carries the same sound with 11 inputs. But the editor cannot duck the music under the
  dialogue regions: the stem's track has no role, and giving it role `speech` would duck under all 90 s
  again.

### 4.2 The proposal's pieces, audio only (same sources, 2 cores)

| Piece | Result |
| :-- | :-- |
| **Premix: 25 clips' sound → one stem**, with the editor's own chains (`render_spec.audio_runs` / `audio_run_filters`: trim, 48 kHz stereo, 20 `acrossfade`s at the cross-fades), one ffmpeg under `ffmpeg_limits` | **1.07 s wall, 121 MB peak RSS**; 26 inputs (one placeholder), 5 amix inputs; stem -16.6 LUFS / -10.7 dBTP |
| Stem under the narration, **editor envelope -12 dB** | narrated scene -24.1 → -36.1 (**12.0 dB**); wordless scene unchanged (-24.1) |
| Stem under the narration, **`sidechaincompress`** (threshold 0.02, ratio 8, attack 20 ms, release 400 ms), key = the narration | narrated scene -24.1 → -40.2 (**16.1 dB**); 0.56 s |
| Same, with the narration key 6 dB quieter | -24.1 → -34.9 (**10.8 dB**): the depth follows the speech level, as `render_spec.py:74-77` warned |
| Proposed premaster: narration (its plan gain) + music at -18 dB, ducked 12 dB under **narration and dialogue regions** + stem at 0 dB, ducked 12 dB under **narration only** | 0.38 s; -15.2 LUFS / -9.9 dBTP |
| Two-pass `loudnorm` I=-14, TP=-1, LRA=11, `linear=true`, **on the proposed premaster** | measured LRA 5.0 → **`normalization_type: linear`**; result -13.9 LUFS / -8.6 dBTP; pass 1 2.57 s, pass 2 0.54 s |
| The same on **today's master** | measured LRA 14.0 → **`dynamic`** (loudnorm ignored `linear=true`); result -14.0 / -9.9 |
| Today's master at LRA 15 or 20 | linear; -14.0 / -11.9 |

The proposed final mix, per scene (band RMS, dB):

| Scene | Speech | Ambience | Music | Speech over music | Speech over ambience |
| :-- | --: | --: | --: | --: | --: |
| 2 narrated | -16.9 | -34.9 | -44.2 | **27.3** | 18.0 |
| 3 wordless | n/a | -22.9 | -32.1 (not ducked) | n/a | n/a |
| 4 dialogue | -16.6 | -19.9 | -44.1 | **27.5** | 3.3 (the clip's own internal mix, see below) |
| 5 silent file | -16.9 | -71.4 (floor) | -44.0 | 27.1 | n/a |

How far to read these numbers:

- They are synthetic **tones**. They prove the routing, the counts, the time and the duck depths.
- They do **not** prove the intelligibility of real speech. That needs a real clip, the owner's ears, and a
  speech-band measure (for example the speech-to-background level per scene, or STOI if wanted).
- The "speech over ambience" margin in a dialogue scene is whatever the clip model mixed inside its own
  file. One stream cannot be separated, so we can only lower or raise both together.

## 5. Constraints for a fix

- **The 32-sound-clip ceiling** (`film_timeline.py:138-142`).
  - It was measured on audio-file inputs. At 1080p under 2 GiB, 32 inputs passed in 15 s; 61-63 stalled
    or crashed (`docs/FILM_ASSEMBLY_MEASUREMENT.md` §1-2, lines 111-146). 33-60 were never measured.
  - What counts today: every A clip (each narration clip, each music tile). The editor's validator also
    counts every V clip with `audio: true` (`timeline.py:846-853`, ceiling 64).
  - The `clip_audio` render above passed with 35 inputs (25 of them 1080p video files read for sound only)
    at 641 MB. **That is one data point above 32, not a new ceiling.** Raising the ceiling needs its own
    measurement up to 64, with video inputs.
  - With a stem, clip sound counts **1**, whatever the shot count. 30 shots then cost 8 + 1 + 1 = 10
    inputs.
- **amix.** ffmpeg allows 1-32767 inputs (`ffmpeg -h filter=amix`). The real limit is the final pass's
  memory per input, above. A cross-faded run of sounding clips is joined by `acrossfade` before amix, so
  the amix count (14) is below the input count (35).
- **Time on 2 cores.** The premix is about 1 s for 25 clips. The two `loudnorm` passes are about 3 s for a
  90 s film. Both are negligible next to the 153-160 s render: the final pass is about 90 s of libx264
  `medium` at 1080p, and the 59 segments take about 65 s. The editor's budget is 390 s.
- **Lip-sync** (S6, `S6_GAPS.md` §4 on PR #901).
  - A lip-synced clip's own sound stays **muted**; the scene's dialogue reaches the film through S6's
    dialogue stem.
  - So the premix must skip a lip-synced take. An explicit field is better than a guess:
    `lipsync_of_asset_id` in its provenance.
  - S6's budget (narration 1 + dialogue stem 1 + music ≤ 4) stays intact: the clip stem adds 1.
- **A clip with no audio stream** must not fail and must not invent sound (rules 4 and 5).
  - Measured: the editor skips it, the master stays at the floor in that scene, and the render does not
    fail.
  - The exception is a take **bought with sound** (`params.audio` true) whose file has none. That is a
    paid-for thing missing; refuse it by name, as vera does (`clip_without_sound`).
  - A model priced inside one price (Veo, H3, ...) that returns no stream is not refused: nobody paid a
    sound variant.
- **"Speaks other words" (H3).** S6 reports that an H3 told to speak moves the mouth to other words
  (`S6_FILM_DIALOGUE.md` §5 on PR #901). Kling keeps the clip's own audio unless `original_audio_volume`
  is 0.
  - With clip sound in the mix, a model that adds unasked speech (or speaks other words than the script)
    now **reaches the audience**.
  - So a scene whose mode is not in-clip dialogue must not carry vendor speech. No vendor documents an
    "ambience only, no speech" control: this is a **Scout question**, and the design does not rely on it.
  - Until it is answered, that scene's sound is either muted, or kept and labelled so a person listens
    before approval.

## 6. The unmerged branch `vera/film-clip-audio` (3bdfe3f86, 21 Nov)

**What it does.**

- A take whose `params.audio` is true gets `audio: true` on its V clip.
- The assembly probes `has_audio` on those videos and stores it on the asset row (`_probe_clip_sound`).
- `build_cut` refuses `clip_without_sound` (the file has none) and `asset_unprobed` (not known).
- The assembly checks it again on the resolver, right before the render.
- Each sounding clip counts toward `MAX_SOUND_CLIPS`.
- The music ducks under clip sound.
- `wants_sound` also covers a film whose only sound is its clips.

**Tests on `main` today.**

- The branch merges cleanly into `main` 948c2f31c. With it merged, `tests/test_film_clip_audio.py`
  (17 tests), `test_film_timeline.py` and `test_film_assembly.py` pass: **125 passed**.
- Its test file alone against unmerged `main` fails 12 of 17, as expected: the feature is absent.

**What it gets right.**

- Only a take whose sound was **priced** plays it. No default changes, and the hash of every existing
  film is unchanged (`FORMAT_VERSION` stays).
- It refuses by name instead of rendering silent (rule 4).
- The probe runs on what the render will actually read.
- Its `wants_sound` fix closes the hole in `film_assembly.py:833` (§1).

**What it misses, measured above.**

1. **The ceiling.** One input per sounding clip. Our 30-shot, 90 s film has 25 sounding clips + 9 A clips
   = 34 > 32, so vera refuses it as `too_many_audio_clips`. Its own message advises "fewer, longer shots",
   which is the opposite of the owner's reels.
2. **The duck.** Clip sound counts as speech, so the music is ducked under one span covering the whole
   film (measured 0.0 to 89.25 s, music -45.3 dB in the wordless scene against -33.3 dB). Ambience and
   slapstick foley are not speech.
3. **No ducking of the clip sound under the narration.** The ambience sat 5.9 dB under the narration in
   our measurement.
4. **No master loudness pass.** The plan still says "not normalised".
5. **Single-price models never play.** Only `kling-v3` and `seedance-1.5-pro` can carry `params.audio`
   (§2.1). H3, Veo, LTX, Seedance 2.x and Vidu sound, already paid inside one price, is still dropped,
   because their takes never have `params.audio`.
6. **Clip sound is treated as dialogue.** Its docstring says the clip "is where the lines are spoken". With
   dialogue as a per-scene mode, a scene's sound role (dialogue / ambience / muted by lip-sync) has to be
   explicit, and the duck and the mix must depend on it.

## 7. Recommended design (proposal only; the fix is its own PR)

This combines Scout's mix (agreed with S1 on 27 Nov), vera's refusals, and the 28 Nov scope (in-clip
dialogue per scene).

### 7.1 One clip-sound stem, made before the final pass

- The assembly premixes every **shown** shot's own sound into one WAV on the film's clock. It uses the
  editor's own chains (`render_spec.audio_runs` / `audio_run_filters`: trim, speed, 48 kHz stereo,
  `acrossfade` at cross-fades, a fade under a silent neighbour), in one ffmpeg under `ffmpeg_limits`.
  Measured at 1.07 s / 121 MB for 25 clips.
- It lays that stem on **one** A track. The final pass then counts clip sound as 1 against
  `MAX_SOUND_CLIPS`.
- What goes into the stem:
  - a shot whose file carries sound (`has_audio` true);
  - not a lip-synced take (S6: muted);
  - not a scene the person muted.
- No sound is invented (rule 5): a file without sound adds silence.

### 7.2 Speech is explicit, not "every clip that sounds"

- The music ducks under the **narration spans and the speech regions of in-clip dialogue scenes**.
  - For a dialogue scene, the region is the scene's span inside the lead and tail, or the lines' times
    once the scene carries them (S6's `lines[].start_s/end_s`).
  - The editor cannot express this today: `speech_spans` takes a V clip's whole span, and a stem track's
    whole extent. So the fix needs either a speech track made of the dialogue regions (one A clip per
    dialogue scene: this counts toward 32), or **explicit duck spans** computed by `film_timeline` and
    passed to the music's `AudioTrack.duck_spans`, a field `render_spec` already has. Explicit spans cost
    no input and are the recommendation.
- The duck stays the editor's deterministic envelope: -12 dB, attack 0.3 s, release 0.8 s.
  - Measured exactly 12.0 dB.
  - Sidechain measured 16.1 dB, or 10.8 dB with a key 6 dB quieter: its depth follows the narration's
    level. That makes "-12 dB" a different thing in every film, which is the reason `render_spec.py:74-77`
    gives for not using it.
- **The ambience stem ducks under the narration only**, -12 dB with the same envelope. In a dialogue
  scene the speech is inside the stem, so the stem stays at its level there. Measured: narration 18.0 dB
  over the ambience, 27.3 dB over the music; dialogue 27.5 dB over the music.

### 7.3 Levels

| Bed | Level | Note |
| :-- | :-- | :-- |
| Narration | -16 LUFS per take, as today | |
| Music | -18 dB, ducked 12 dB under all speech, as today | The 120 Hz tone in our test read -32 dB undecked and -44 dB ducked |
| Clip stem | 0 dB gain to start with | A clip's own sound level is **unknown until a real clip is measured** (§8). The default needs one real Kling or H3 file per language before it is fixed. |

### 7.4 One master loudness pass

- Mix the sound alone first (about 0.4 s).
- Measure it with `loudnorm` I=-14, TP=-1, `print_format=json` (2.6 s for 90 s).
- In the final pass, apply the measured values with `linear=true`, then `aresample=48000`.
- Read `normalization_type` from the pass-2 output. If it is not `linear`, **fail by name**
  (`loudness_not_linear`, remedy in the detail) and never ship the dynamic compressor's sound.
- Choose the LRA target from a measurement, not by habit.
  - LRA 11 refused today's narration-only master: measured LRA 14.0, so dynamic.
  - The ambience-filled mix measured LRA 5.0, so linear.
  - A film with narration and long silent clips will look like today's master. Either set LRA 15-20
    (today's master went linear at 15), or say in the failure what to do (add music, or turn clip sound
    on).
- -14 LUFS is the usual figure quoted for YouTube's playback normalisation. It is **unverified here** (a
  Scout item); the target belongs in one constant.

### 7.5 Opt-outs and the quote

- A per-scene switch, "this scene's sound: dialogue / ambience / muted", stored on the scene. There is
  `clip_params.audio` today, and a mute that needs no new price is better than a second meaning of
  `clip_params.audio`.
  - `clip_params.audio` stays what it is: which **priced** variant is bought (kling-v3,
    seedance-1.5-pro).
  - Muted or not, a priced sound variant is a purchase. The quote already says it per clip line
    (`0171:760-769`, `audio` in the line's params).
- The quote and the plan show, per scene, whether the clip's sound is used, and say "no sound in the file"
  when the probe found none.
  - Never a silent swap: a scene bought with sound whose file has none is refused (vera's
    `clip_without_sound`), not quietly muted.
  - A single-price model's sound is labelled "included in the clip's price", never added as a new charge.
- The master's plan records the loudness pass's result: measured I, TP, LRA, and "linear". It replaces
  "not normalised".

### 7.6 Tests the fix PR must pin

1. A film whose shots carry sound has that sound in the master: the clip tone's band reaches its source
   level, not the floor (this tool's method).
2. A shot whose file has no audio stream renders silent, with no error and no invented sound. A shot
   **bought** with sound and without a stream is refused `clip_without_sound`.
3. A 30-shot film with clip sound has at most narration + music + 1 sound inputs in the final pass, and is
   not refused `too_many_audio_clips`.
4. The stem's cross-fades are `acrossfade`, not doubled (vera's test, kept). A sounding shot next to a
   silent one fades in and out under it.
5. The music is ducked under the narration and the dialogue scenes' regions, and **not** under ambience or
   a wordless scene. Pin the duck spans and the measured -12 dB.
6. The ambience is ducked under the narration and not in a dialogue scene.
7. A lip-synced take's own sound is not in the stem (S6).
8. A muted scene contributes silence, and the cut's hash changes when the mute changes.
9. A film with no clip sound has the same document and hash as before (`FORMAT_VERSION`), except for the
   loudness pass, which is a deliberate format bump.
10. Two-pass loudnorm: the master is within ±0.5 LU of the target and under the TP ceiling, and the pass-2
    `normalization_type` is `linear`. A forced dynamic case (for example a narration-only film at
    LRA 11) fails `loudness_not_linear` by name, at 0 credits.
11. `wants_sound`: a film whose only sound is its clips must come out with an audio stream (vera's test,
    kept).
12. The plan says, per scene, "clip sound: used / no sound in the file / muted / lip-synced", and never
    "used" for a file the probe found silent (rule 5).

## 8. Read-only: how well do clip models speak Uzbek and Russian inside a clip?

No live job or database was read for this section: Atlas does the live check. From the repo:

- **MiniMax H3.**
  - `NIGHTSHIFT_AI.md:100` lets the Brain offer `clip_audio`, where "the video model (MiniMax H3 t2v/i2v,
    verified 20 Nov) speaks them". What exactly was verified on 20 Nov is not written down.
  - `S6_GAPS.md` §1.4 (PR #901) says the official pages document neither the languages nor word-for-word
    speech, lip motion, or a stable voice. The "11 languages, no Uzbek" list comes only from mirrors. Its
    verdict: en/ru only until a probe the owner listens to; not enough for Uzbek.
  - S6 also reports H3 "moves the mouth to other words".
- **Kling.** Kling's TTS lists `zh` and `en` only (S6_GAPS §1, `voice_language` values). Native audio on
  `kling-v3` is "search extracts", unconfirmed (`model_registry.json`, `api_documented.note`).
- **Veo, LTX, Seedance, Vidu, Grok, Gemini Omni.** Nothing in the repo about in-clip speech in any language.
- **Showcase samples.** None has sound in our copies (§2.3), and no showcase prompt asks for spoken lines.
- **Narration voices**, for contrast: Uzbek is checked per TTS model (`tts_languages.py`, migration 0214:
  "unknown is never 'speaks'").

**What cannot be known without a paid sample, per model and language (uz, ru, en):**

- whether the lines in the prompt are spoken word for word;
- the accent and intelligibility (the owner's ears);
- the lip-sync quality;
- whether the voice stays the same across a film's 7-15 dialogue clips;
- whether two characters keep two voices;
- whether the model adds unasked speech in a scene meant as ambience, and whether a prompt can stop it;
- the clip sound's loudness (LUFS / LRA), so the stem's default gain in §7.3;
- whether `generate_audio: false` is truly silent (S6's H1);
- whether a single-price model's sound is in every file or only some.

## 9. Open questions for the owner

1. In a narrated scene, keep the clip's ambience (ducked 12 dB under the voice), or mute it? Proposed:
   keep it. 3 of the 14 reels live on foley.
2. Is a scene muted by a person still charged for the sound variant it was bought with? Proposed: yes;
   the purchase is the person's choice and is shown on the quote.
3. Which loudness target: -14 LUFS (YouTube's usual figure, unverified here) or the editor's -16? And
   should a film that cannot normalise linearly fail, or ship at a wider LRA?
4. For in-clip dialogue in Uzbek: only after a paid sample the owner listens to (§8). Who pays for it, and
   which models (H3, Kling v3, Veo)?
5. Until a vendor documents "ambience, no speech", should a non-dialogue scene on a speaking model be
   muted by default, or kept and listened to before approval?

## 10. Scout questions

- Is there a documented "no speech / ambience only" control on MiniMax H3, Kling v3, Veo 3.1, LTX,
  Seedance? Today it is unverified; do not rely on it.
- Does YouTube normalise playback to -14 LUFS, and does it penalise a louder master?
- Kling v3 native audio: confirm on the vendor's v3 endpoint (the registry note says it is not confirmed).

## 11. Reproduce

```bash
taskset -c 0,1 python3 tools/clip_audio_measure.py --dir /tmp/s2clip --scenes 30 --scene-s 3 --res 1080p \
    --out /tmp/s2clip.json            # about 9 minutes on 2 cores: three 1080p renders + the audio pieces
```

The tool synthesises every source with ffmpeg lavfi or Python, writes nothing outside `--dir`, calls no
provider, and is imported by nothing in production. Machine: 4 vCPU, 16 GB, limited to 2 cores with
`taskset`; ffmpeg 6.1.1 (production uses the imageio-ffmpeg build, so the numbers may differ slightly).
Earlier smaller runs (6 and 8 scenes at 720p) gave the same routing and duck results. The vera branch
check:

```bash
git fetch origin vera/film-clip-audio
git worktree add --detach /tmp/vera origin/main && cd /tmp/vera
git merge --no-commit --no-ff origin/vera/film-clip-audio
python3 -m pytest -q tests/test_film_clip_audio.py tests/test_film_timeline.py tests/test_film_assembly.py   # 125 passed
```
