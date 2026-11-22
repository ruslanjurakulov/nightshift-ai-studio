# S4 — Assembly & export: what P4b does on real files, and what is missing (22 Nov 2026)

Stream S4 of docs/studio/PROGRAM.md. Rule 8: evidence first, then the diagnosis, then the changes. Nothing below was fixed
before it was measured. The earlier measurement of the editor's render path (docs/FILM_ASSEMBLY_MEASUREMENT.md) still
stands. This one runs **P4b itself** (`modules/film_assembly.assemble_segment`) end to end, at every aspect and length a
film is offered at.

## Evidence

### What ran

`tools/film_assembly_e2e_measure.py run` calls `film_assembly.assemble_segment` exactly as the film worker does. These
parts are real, not faked:

- the render: `render_strict` → `timeline_render` → `render_backend` → ffmpeg under `ffmpeg_limits`;
- the free-disk check;
- the output checks;
- `media_library.store_generated`, with its thumbnail and its 480p proxy, which is the review copy;
- `store_caption`, the WebVTT sidecar;
- `_check_master`, the review-copy ceiling.

Only two things are replaced:

- **The database.** An in-memory twin of 0171's assembly calls takes its place (begin, record, heartbeat, the asset
  rows), the same shape as `tests/test_film_assembly.FakeDb`.
- **Whisper.** The take carries its word timings, so Whisper does not run inside the matrix. It is measured on its own
  below.

No provider was called and nothing was spent. The media:

- **Clips.** The public site's showcase clips that are already in the repository
  (`command-center/components/site/showcase/*/clip.mp4`). These are real AI video: silent H.264, 1280 wide, 24 fps,
  5-10 s each. The harness picks them per aspect within the timeline's 2 % tolerance: 1280x720/732 for 16:9, 1280x2240
  for 9:16, 1280x1280 for 1:1. They are upscaled to the 1080p frame, the films' default resolution.
- **Narration.** One mono 128 kb/s MP3 per film, made by ffmpeg (tone bursts in the speech band, no TTS). It is laid out
  **on the film's clock** as P3's contract says: each scene's words start `NARRATION_LEAD_S` (0.25 s) into the scene, so
  every film has one narration clip. The take carries `segments`, the take's measured `loudness_lufs` / `true_peak_db`
  (ffmpeg ebur128), and per-scene word timings.
- **Sync marker.** The narration has a 60 ms 3 kHz marker at the start of every scene's words. The output's sync is read
  at every cut: marker onset (band-passed audio, `silencedetect`) against the scene's cut (video `select=gt(scene,…)`).
- **Music.** A 30 s stereo AAC loop, so a 180 s or 600 s film tiles it with fades and ducks it under the narration.
- **Captions.** `captions_mode = both`: burned in and the VTT sidecar.
- **Scenes.** One shot each, 5 s scenes for 10/60/180 s (2/12/36 scenes), 10 s scenes for 600 s (60 scenes, the 0166
  maximum). Transitions are `cut`, so sync can be read at each cut. One 180 s film was made with cross-fades for their
  cost.
- **Memory limit.** Every run is inside a cgroup-v1 memory group limited to **3 GiB**, the film-worker's `mem_limit: 3g`
  (deploy/docker-compose.yml). Docker enforces that limit with the same counter, page cache included.

### The machine

A development container, **not the AX42 media server**: 4 vCPU (Xeon @ 2.1 GHz), 15.7 GiB RAM, ffmpeg 6.1.1, Python
3.13, 60 GB free. It was **idle**: the one-minute load was about 0.1 before each run, and the load during a run (1-4) is
the render's own threads. Wall times therefore carry over only to an idle 4-core machine. The CPU seconds are the
transferable figure.

```bash
W=<scratch>
python3 tools/film_assembly_e2e_measure.py run --aspect 16:9 --seconds 180 --work $W/w --out r.json   # inside the 3 GiB group
python3 tools/film_assembly_e2e_measure.py run --aspect 16:9 --seconds 600 --scene-s 10 --work $W/w --out r600.json
python3 tools/film_assembly_e2e_measure.py table r*.json
```

### Results: the matrix (1080p, cuts, music, captions burned and sidecar)

| aspect | film | scenes | result | wall s | budget s | CPU s | largest ffmpeg MB | worker process MB | cgroup peak MB (cache incl.) | disk used MB | disk asked MB | master MB | length error s | review copy MB | review / 50 MB | sync max \|offset\| s (markers) | cut max \|error\| s |
| :-- | --: | --: | :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-- | :-- |
| 16:9 | 10 | 2 | ok | 15.9 | 150 | 46 | 542 | 24 | 597 | 46 | 90 | 6.1 | 0.000 | 0.98 | 2 % | 0.000 (2/2) | 0.000 (1/1) |
| 16:9 | 60 | 12 | ok | 75.5 | 300 | 216 | 562 | 25 | 838 | 241 | 540 | 25.9 | 0.000 | 3.83 | 8 % | 0.001 (12/12) | 0.000 (11/11) |
| 16:9 | 180 | 36 | ok | 208.7 | 660 | 610 | 572 | 25 | 1,392 | 736 | 1,620 | 81.6 | 0.000 | 12.24 | 24 % | 0.001 (36/36) | 0.000 (35/35) |
| 16:9 | **600** | 60 | ok | **794.0** | 1,920 | 2,361 | 585 | 26 | **3,221 (the limit)** | 2,955 | 5,400 | 324.0 | 0.000 | **49.37** | **98.7 %** | 0.001 (60/60) | 0.000 (59/59) |
| 9:16 | 10 | 2 | ok | 13.7 | 150 | 36 | 539 | 25 | 612 | 49 | 90 | 3.6 | 0.000 | 0.46 | 1 % | 0.000 (2/2) | 0.000 (1/1) |
| 9:16 | 60 | 12 | ok | 71.9 | 300 | 207 | 556 | 25 | 887 | 252 | 540 | 24.2 | 0.000 | 3.86 | 8 % | 0.001 (12/12) | 0.000 (11/11) |
| 9:16 | 180 | 36 | ok | 208.5 | 660 | 604 | 562 | 25 | 1,470 | 749 | 1,620 | 71.8 | 0.000 | 11.48 | 23 % | 0.001 (36/36) | 0.000 (35/35) |
| 9:16 | **600** | 60 | ok | 722.9 | 1,920 | 2,140 | 585 | 26 | **3,221 (the limit)** | 2,730 | 5,400 | 260.5 | 0.000 | **41.09** | **82 %** | 0.001 (60/60) | 0.000 (59/59) |
| 1:1 | 10 | 2 | ok | 7.9 | 150 | 20 | 356 | 24 | 416 | 23 | 55 | 1.9 | 0.000 | 0.32 | 1 % | 0.000 (2/2) | 0.000 (1/1) |
| 1:1 | 60 | 12 | ok | 42.4 | 300 | 111 | 360 | 25 | 551 | 135 | 330 | 11.2 | 0.000 | 1.96 | 4 % | 0.001 (12/12) | 0.000 (11/11) |
| 1:1 | 180 | 36 | ok | 127.6 | 660 | 340 | 370 | 25 | 879 | 407 | 990 | 33.4 | 0.000 | 5.83 | 12 % | 0.001 (36/36) | 0.000 (35/35) |
| 16:9, **cross-fades** | 180 | 36 | ok | 283.7 | 660 | 817 | 565 | 25 | 1,545 | 839 | 1,620 | 102.6 | 0.000 | **15.62** | 31 % | not read (no hard cuts) | - |

Columns:

- *budget*: `timeline.render_timeout_s(length)`, which the assembly gives the render.
- *CPU s*: user + system time of every child process.
- *largest ffmpeg*: the maximum resident set of any one child (`RUSAGE_CHILDREN`).
- *worker process*: the assembly's own Python process.
- *cgroup peak*: `memory.max_usage_in_bytes`, page cache included.
- *disk used*: the media root's growth during the run, sampled every 0.5 s (the work folder, the master, its proxy and
  thumbnail, the VTT).
- *disk asked*: `disk_needed_mb`, what the free-disk check demands.

Every run's frame was the aspect's: 1920x1080, 1080x1920 and 1080x1080. Every review copy was 480 on its short side:
854x480, 480x854 and 480x480. Every output had sound and the captions sidecar.

What the numbers say:

- **Length is exact.** The file length minus the sum of the scenes is 0.000 s in all 12 runs. The tolerance is 0.12 s.
- **A/V sync holds across the whole film.**
  - Every marker was found at every cut, at every aspect and length, within **1 ms** of where the cut is.
  - The last marker of a 10-minute film is as close as the first: there is no drift.
  - The narration's 0.25 s lead appears as the audio stream's `start_time` (0.228 s, the AAC priming), as the earlier
    measurement found. The audio ends exactly with the picture.
- **Time is linear and far inside the budget.** 3.4-4.6 CPU-seconds per second of 16:9/9:16 film. The 10-minute 16:9 film
  ran 794 s, 41 % of its 1,920 s budget, at about 3.0 cores. It needs about 1.25 cores for the whole film to finish
  inside its budget. 1:1 costs about half as much.
  - Cross-fades cost a third more: 817 against 610 CPU s at 180 s.
- **Disk.** The check asks for 1.8-2.2 times what was used, the headroom the earlier measurement chose on purpose.
- **Memory in any one ffmpeg stays under 600 MB** (585 MB at 10 minutes, 1080p) and does not grow with length.
- **The 3 GiB group reached its limit on both 10-minute films.**
  - Peak 3,221 MB; `memory.failcnt` 107,019 (16:9) and 156,136 (9:16); `oom_kill` 0; `under_oom` 0.
  - Both films finished. What filled the group is page cache of the intermediates, which the kernel reclaimed every time
    it hit the limit.
  - The assembly's own memory in that group was its largest ffmpeg (585 MB) plus the worker process (26 MB). In production
    the worker process is not 26 MB: see Whisper below.

### Results: Whisper (the captions' word timings)

The matrix passes word timings in the take. In production 0171's contract gives the take **no `words`** (0038's 16 KB
provenance cap, Lens L4). So every captioned film runs `film_assembly.whisper_words` on its narration file inside the
film-worker process. It was measured with the exact call: `whisper.load_model("base")`, then
`transcribe(word_timestamps=True, fp16=False, temperature=0.0, …)`. The versions were `openai-whisper==20250625` (the
pinned constraint) and torch 2.15 CPU, on the same 4 vCPU. The audio was the synthetic narration, because the repository
holds no speech: the cost depends on the audio's length, but the words it returned are not meaningful.

| narration | load s | transcribe s | CPU s | peak RSS of the process | RSS still held after the call returns (model out of scope, `gc.collect()`) |
| --: | --: | --: | --: | --: | --: |
| 180 s | 0.9 | 12.5 | 45 | 1,186 MB | - |
| 600 s | 0.8 | 31.4 | 116 | 1,249 MB | **810 MB** (782 MB after a second call) |

**Where the model is looked for.** The installed `whisper/__init__.py:132-134` reads:

```python
default = os.path.join(os.path.expanduser("~"), ".cache")
download_root = os.path.join(os.getenv("XDG_CACHE_HOME", default), "whisper")
```

With the film-worker's `HOME: /tmp` (deploy/docker-compose.yml, `user: "1000:1000"`) that resolves to
`/tmp/.cache/whisper` (checked: `HOME=/tmp python -c …` prints it). The worker image
(Dockerfile.worker) fetches the model at build time on purpose ("not in the middle of the first run, after the script
and the voice are already paid for"), then moves it to `/home/nightshift/.cache/whisper`, owned by uid 10001. The
film-worker runs as uid 1000 with `HOME=/tmp` and no `XDG_CACHE_HOME`.

### What could not be measured here

- **The AX42 itself.** The owner's timed run on the media server stays owed (docs/FILM_ASSEMBLY_MEASUREMENT.md, last
  section).
- **A 10-minute cross-fade film.** Every showcase clip is at most 10.13 s long. A 10 s scene with a 0.5 s cross-fade
  needs 10.55 s of footage, so the harness refuses to build one. Only the 180 s cross-fade film was rendered.
- **Real speech through Whisper.** No TTS is used, and there is no speech file in the repository, so caption *accuracy*
  is not measured here. Only Whisper's time and memory are.
- **The film-worker container as built.** Its whisper path was read from the code and the compose file, not run.

## Diagnosis

In order of what would hurt a paid film first.

### G1 — Whisper's model is not where the film-worker looks (high, before any captioned film)

- The film-worker's Whisper reads `/tmp/.cache/whisper`, a tmpfs that is empty at every start. The model the image
  cached at build time sits under another user's home, in a path Whisper never computes.
- So the first captioned assembly after every container start downloads 139 MB from Whisper's host (openaipublic, Azure
  CDN) into `/tmp`. That is a tmpfs, so the file counts against the same 3 GiB memory limit as shmem, and the kernel
  cannot reclaim it.
- **Download refused or failing** (network policy, an outage): the assembly fails as `captions_failed` at 0 credits.
  That is correct by rule 4, but it happens **after every take was paid for**, and its detail says "retry the assembly",
  which would fail the same way. That is rule 6 twice: the run fails late, and the remedy named is the wrong one.
- **Download succeeds**: it works, silently depending on the network, which the Dockerfile set out to avoid.

**After (`claude/nsai-s4-whisper-model`).**

- The image keeps the baked model where it was downloaded, `/opt/whisper-cache/whisper`, root-owned and readable by
  every uid (`chmod -R a+rX,go-w`). It names that folder with `ENV NIGHTSHIFT_WHISPER_DIR=/opt/whisper-cache/whisper`.
  An image ENV and not a compose line: every service started from the image inherits it, and the film-worker block is
  unchanged. The pipeline worker's `~/.cache/whisper/base.pt` is now a symlink to the same file, so its default lookup
  works as before without a second 139 MB copy.
- `film_assembly.whisper_words` reads only `NIGHTSHIFT_WHISPER_DIR` and never downloads:
  - It checks the file before it starts anything. The child verifies Whisper's own sha256 before `load_model("base",
    download_root=…)`, so Whisper's re-download on a checksum mismatch is never reached, and the child disables
    `urllib.request.urlopen` anyway.
  - A missing variable, a missing, empty, unreadable or wrong `base.pt`: the assembly refuses with the new
    `captions_unavailable` ("rebuild the worker image (Dockerfile.worker bakes it), or set captions to none"), not
    "retry".
- `film_assembly.captions_model_ready() -> (bool, str)` is the path-only check (no torch import). S2 calls it at the
  film worker's start (pending, in tools/film_worker.py after this change). Then a worker without the model claims
  nothing, only sweeps, and reports `worker_status` failed. **Until then nothing calls it before the takes are paid:**
  a missing model is found at assembly time, as `captions_unavailable`.
- Not run here: the film-worker container as built (no image build in this container). The image and compose are
  checked by tests (`tests/test_worker_image_pins.py`, `tests/test_deploy_self_host.py`).
- Not changed (outside this scope, same default-root lookup): `modules/voice_worker.py:331`
  (`whisper.load_model(WHISPER_MODEL)`) and the whisper check in `tools/doctor.py` (`$HOME/.cache/whisper`).

### G2 — The review copy is at its ceiling at the longest film (high, at 10 minutes)

- The library's proxy (`media_library.proxy_command`: 480p, libx264 veryfast crf 28, AAC 96 kb/s) is constant-quality,
  so its size follows the footage, not the length cap. On real AI footage:
  - 10-minute 16:9: **49.37 MB, 98.7 % of 50 MB**.
  - 10-minute 9:16: 41.09 MB.
  - Cross-fades make the proxy 1.28 times larger at 180 s (15.62 against 12.24 MB). A 10-minute cross-fade film is
    therefore estimated at about 63 MB. That is an estimate, not a measurement (above).
- `_check_master` then fails the assembly as `review_copy_too_large` with "shorten the film". By then the film has been
  rendered, stored and paid for in takes; the assembly is charged 0 and the master is thrown away. The earlier
  measurement predicted this (22 MB on synthetic clips, "real provider footage could give a larger proxy") and named the
  remedy: a bitrate-capped review encode. The remedy in today's detail, "shorten the film", is the wrong one: the master
  is fine, only its preview is too big.

### G3 — A film's captions cannot be downloaded (medium)

- `GET /api/library/{asset}/download?variant=captions` builds the SRT only from `editor_exports.doc->captions`, read by
  `asset_id`. A film master has no editor export, so it answers `404 no_captions`.
- The film's VTT is its own library file (`kind = caption`), named in the master's provenance (`captions_asset_id`).
- The live view's final card renders `<AssetDownloads … preview="ready" />` without `captions`
  (`components/studio-live/LiveView.tsx:384`). So no broken button is shown: the person simply cannot take the captions
  with the film.

### G4 — The worker's memory margin at 10 minutes (medium, measured, not failing)

- **Page cache:** the render alone fills the 3 GiB group with page cache at 10 minutes. That is reclaimable and did not
  fail.
- **Anonymous memory:** in production the worker process also holds about **800 MB that Whisper leaves behind** (above),
  and with G1 unfixed another 139 MB of tmpfs. The anonymous floor during the render is then about 800 MB (Python with
  torch) + 585 MB (the largest ffmpeg) + 139 MB (shmem) ≈ 1.5 GB of 3 GiB.
- That fits, at half the margin the matrix shows. It is not a failure today. It is the number to keep in mind before the
  limit, the resolution or the length grows.

**After (`claude/nsai-s4-whisper-model`).** The transcription runs in a child, `python -m modules.film_whisper`. Its
environment is reduced to PATH, HOME, TMPDIR, locale and thread variables, so no key reaches it. Its arguments are the
model folder, the language and two paths. The words come back as a JSON file.

The timeout is the render's own budget for the same length, `timeline.render_timeout_s`: `3 × length + 120 s`, at
most 5,400 s. The length is read by ffprobe. At 600 s that is 1,920 s, 4.7 times the slowest loaded run below (412 s).
An unknown length is budgeted as the longest film, 600 s, and the detail says "a narration of unknown length (budgeted
as the longest film, 600 s)" rather than showing 600 s as measured.

Until S2's assembly-only re-run ships (0221), a failed assembly can only be answered by starting the film again, so no
caption remedy says "retry the assembly". The failures map like this:

| child outcome | refusal | remedy |
| :-- | :-- | :-- |
| exit 3 (the model is missing or would not load, this Whisper names no `base` checksum, or ffmpeg would not start) | `captions_unavailable` | rebuild the worker image |
| exit 4 (ffmpeg ran and could not decode the narration) | `captions_failed` | generate the narration again |
| exit 5 (out of memory in the load or the transcription) | `captions_failed` | start the film again when the worker is idle |
| killed by a signal | `captions_failed` | most likely memory; start the film again when the worker is idle |
| timeout | `captions_failed` | the worker is overloaded; start the film again when it is idle |
| exit 0 with no words (`[]`) | `captions_failed` | no speech was heard: generate the narration again |
| exit 0 with unreadable or malformed words | `captions_failed` | rebuild the worker image |
| any other exit | `captions_failed` | start the film again |

Every one also offers "or set captions to none". The child's stderr goes to a file, and its last 600 bytes are
logged on every failure. The word cache keeps only a non-empty list of well-formed words; an empty or damaged entry is
deleted and transcribed again.

Measured with the same venv (openai-whisper 20250625, torch 2.15 CPU) and the same synthetic 600 s mp3, on the same 4
vCPU. This time the container was shared with other test runs (load average 5.5 to 7.7):

| path | process that goes on to render: RSS before → after | its peak | transcriber peak | wall | words |
| :-- | --: | --: | --: | --: | --: |
| in-process (as before) | 401 → **771 to 812 MB** | 1,261 to 1,267 MB | (the same process) | 71 to 258 s | 385 |
| child (now) | 20 → **20 to 21 MB** | 21 MB | 1,292 to 1,304 MB, returned at exit | 46 to 412 s | 385 |

- The words the child returned are byte-identical to the in-process call's, compared over three pairs. The child
  passes Whisper the decoded samples instead of the path. That is what `transcribe` does with a path itself
  (`log_mel_spectrogram` calls `load_audio` at 16 kHz), so the output is the same.
- The wall times here measure the shared host, not the change. The unloaded figure stays the one above (31 s). The
  child adds a torch import and one extra sha256 of 139 MB; that overhead was not measured on an idle host. The
  slowest loaded run (412 s) used 21 % of the 1,920 s budget.
- The parent's RSS is that of the measurement harness (`film_assembly` imported, no torch). In the film-worker it is
  the worker's own, which is also no longer raised by Whisper's 800 MB: the anonymous floor during the render goes from
  about 1.5 GB to the largest ffmpeg plus the worker itself.

### G5 — Not gaps (measured fine; no change)

- **Sync, length, frame, sound:** exact, every cut, every aspect, every length.
- **Time:** 41 % of the budget at 10 minutes on 4 idle cores.
- **Disk:** the check asks for about 2 times what is used.
- **Download of the master:** `GET /api/library/{asset}/download?variant=original` already serves the film's master as an
  attachment, under the member's own session (RLS on `media_assets`; another workspace's id is a 404; never the service
  key). The live view already offers it. `?variant=preview` redirects to a signed, expiring (600 s) link of the 480p
  proxy.
- **The read model:** S3's lane can show the master with what exists. `/api/films/[id]/live` reads
  `film_segments.assembly_status` / `assembly_asset_id` as the member, and `lib/studio/liveGraph.ts` maps them onto the
  final node. No new route or migration is needed for it.
- **The private upload:** films have no upload path yet. That is P8 (`send_film_to_channel`, not built). Nothing here
  publishes, and the publish gate is untouched.

### Open questions for Atlas (not decided here)

- **Should a film's review copy also be copied to the Supabase `previews` bucket?**
  - Pipeline videos do it (`modules/video_review.py`).
  - Film review copies are served from the media volume through the signed link above, which works without Supabase
    Storage and keeps the 1 GB free-tier total untouched.
  - S4 keeps the 50 MB ceiling either way, so a copy stays possible. A copy is only built if Atlas decides it is wanted.
- **Loudness.** With narration correction, music and ducking the masters measured -16.7 (60 s), -17.8 (180 s) and
  -16.8 LUFS (600 s), against the narration's -16 target.
  - This is synthetic tone narration, and the editor has no master loudness pass (`film_timeline` says so in its plan).
  - The 180 s figure, 1.8 LU low, is not explained by this measurement. It is recorded, not acted on.

## The changes (one draft PR each, from `claude/nsai-s4-<topic>`)

| PR | Gap | Change | Files |
| :-- | :-- | :-- | :-- |
| `claude/nsai-s4-gaps` (this) | - | This document and `tools/film_assembly_e2e_measure.py` | docs, tools |
| `claude/nsai-s4-review-copy` | G2 | The film's review copy is encoded for the ceiling: 480p, crf 28 *capped* at the bitrate that fits 45 MB for the film's length (`45 MB × 8 / length − 96 kb/s`). It replaces the library's proxy variant of the master; the master is untouched. The review copy is a preview, not the film, so a lower bitrate there is not a quality fallback of what is delivered. Measured before and after on the 10-minute 16:9 film. `review_copy_too_large` stays as the last guard, with a remedy that names the real cause | `modules/film_assembly.py`, tests |
| `claude/nsai-s4-whisper-model` | G1, G4 | `whisper_words` loads from an explicit, read-only model folder baked into the image (`download_root`), never downloads at run time, and refuses by name (`captions_unavailable`: "the captions model is not installed on this worker") when the file is not there. Transcription moves to a child process, so its 800 MB is returned before the render. The worker image and the film-worker's environment change with it, which is **a shared file: Atlas first** (Dockerfile.worker, deploy/docker-compose.yml). The fail-early check of the model at the worker's start is S2's file (`tools/film_worker.py`); S4 hands S2 the function | `modules/film_assembly.py`, tests; Dockerfile.worker / compose via Atlas |
| `claude/nsai-s4-film-captions-download` | G3 | `?variant=captions` on a film master serves its captions file (provenance `captions_asset_id`, read as the member under RLS, `kind = caption`, the same workspace) as an SRT attachment. The editor-export path is unchanged. S3 is told the live view can pass `captions` | `app/api/library/[asset]/download/route.ts`, `lib/libraryDownload.ts`, tests, i18n if any string |

No migration is needed for any of these, so 0213 stays unused.
