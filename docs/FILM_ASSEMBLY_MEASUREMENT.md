# Film assembly, measured (Film Studio P0)

Film Studio assembles 10-60 AI clips, a narration, a music bed and captions into one 3-10 minute film on the media-worker,
through the editor's render path (`timeline_render` → `render_backend`, docs/FILM_STUDIO.md). Before P4 picks its defaults,
CLAUDE.md rule 8 asks for the evidence: can that path assemble a 10- and a 15-minute film inside the media-worker's limits,
what fails first, and how much disk does it take?

This is that measurement. It was **not run on the media-worker**: it ran in a shared development container (below), with
the media-worker's memory limit emulated. The memory and disk numbers carry over (they depend on the frame, the document
and the code, not on the machine); the wall times do not, and they are given with the load the machine was under. Timing
one assembly on the media-worker itself stays an owner step (the last section says how).

## Evidence

### What ran

* **The editor export's own call.** `tools/film_assembly_measure.py run` builds a timeline document and renders it with
  exactly the call `editor_export.run_export` makes: `timeline_render.render(norm, resolver, out, ffmpeg=…, workdir=…,
  jobs=1, timeout_s=…)`. Every ffmpeg therefore ran under `ffmpeg_limits` as an export's does: 2 GiB of address space
  each (`CHILD_MEM_BYTES`), two decoder threads per input, four encoder threads, one segment at a time. No production code
  was changed; the script only records each ffmpeg's wall time, CPU time and peak RSS around `ffmpeg_limits.run`.
* **The film.** 60 scenes (the 0166 maximum) of equal length: 10 s each for 10 minutes, 15 s each for 15 minutes, 4 s
  each for the 4-minute 1080p run. Each scene is 1-3 shots of 6-10 s, trimmed to fit, with a cut between the shots of a
  scene and a 0.5 s cross-fade between scenes (59 cross-fades: the most expensive segment the backend makes, two decoders
  in one process). Sound: the narration take, either cut into one A clip per scene (60 clips, "per-scene clock") or as one
  clip because the take already runs on the film's clock ("film clock"); a 240 s music bed tiled with fades (1-4 clips,
  -18 dB), ducked 12 dB under the narration by the editor's duck envelope. Captions: a cue every 3 s of narration (180 for
  10 minutes, 300 for 15), two lines each, burned in at the bottom of a 16:9 frame. 30 fps.
* **The media.** Made locally by ffmpeg; no provider was called and nothing was spent. 12 clips of 6-10 s, silent H.264
  High at 24 and 30 fps (alternating), 8 Mb/s at 1080p and 5 Mb/s at 720p (chosen as typical of i2v output, not measured
  from a provider). What a clip shows decides how big the render's intermediates are, so three kinds are mixed: a
  Mandelbrot zoom (fine detail in constant motion; its crf-12 intermediate is 5.1 MB/s at 1080p, close to the 6.2 MB/s
  `render_backend` measured on grainy real footage), a moving test pattern (3.1 MB/s) and smooth drifting gradients
  (1.2 MB/s). Narration: one mono 128 kb/s MP3 of speech-like bursts and pauses. Music: a 240 s stereo AAC chord loop with
  a beat. The pool is reused across scenes (the same 12 files under 12 asset ids), so the page cache helped the decoders
  a little more than 120 distinct files would.
* **The memory limit.** The script moves itself into a cgroup-v1 memory group with `memory.limit_in_bytes` = 4 GiB, the
  media-worker's `mem_limit: 4g` (deploy/docker-compose.yml), so every ffmpeg it starts is inside it. Docker enforces
  `mem_limit` with the same counter, page cache included. `systemd-run` was not available (no systemd in the
  container); `prlimit` would only set a per-process address-space limit, which `ffmpeg_limits` already sets.
* **The disk guard.** `render_backend.intermediate_x264` picks the fast intermediates (crf 12 ultrafast) when the work
  directory has 8 MB per second of 1080p film free, and otherwise the old compact ones (libx264 defaults: medium, crf 23).
  The container's disk had 1-5 GB free and was shared, which a 1080p film on the fast path would have filled, so every run
  says which it used and why: `--assume-free-mb 100000` tells the guard what a roomy production volume would (fast),
  `--assume-free-mb 1` what a short one would (compact), and no flag lets the guard read the real disk.

### The machine

A shared development container, **not the media-worker**: 4 vCPU (Intel Xeon @ 2.10 GHz), 15.7 GiB RAM, no swap,
Linux 6.18, ffmpeg 6.1.1 (Ubuntu build), Python 3.11.18. Other sessions were working on it the whole time. The one-minute
load average, logged every 30 s, averaged **20.7** during the 10-minute 720p run, **14.9** during the 15-minute 720p run
(peak 25), **10.6** during the 4-minute 1080p run and **4.9** during the 10-minute 1080p run, on 4 CPUs. So the
wall times are several times what an idle machine of this size would take; the CPU times are the transferable figure.

The media-worker (deploy/docker-compose.yml): the `nightshift-worker` image (Debian bookworm's ffmpeg, a different version
from this one), `mem_limit: 4g`, `cpu_shares: 512` and no CPU cap, on the Hetzner AX42 of docs/DEPLOY_AX42.md (8 cores,
64 GB, 2×512 GB NVMe in RAID1, per that document), shared with the web app, the queue worker's pipeline renders and the
creative worker.

### Commands

```bash
FM=<a scratch folder>
# the media (once per frame size; ~80 MB at 720p, ~100 MB at 1080p)
python3.11 tools/film_assembly_measure.py generate --dir $FM/src720  --res 720  --film-s 900
python3.11 tools/film_assembly_measure.py generate --dir $FM/src1080 --res 1080 --film-s 600

# a 4 GiB memory group under this shell's own (cgroup v1)
CG=/sys/fs/cgroup/memory$(grep ':memory:' /proc/self/cgroup | cut -d: -f3)/film-measure
M="--cgroup $CG --mem-limit 4g --work $FM/work"
python3.11 tools/film_assembly_measure.py run --dir $FM/src720 --res 720 --minutes 10 $M \
    --out r720_10_fast.json --assume-free-mb 100000 [--narration-loudnorm 1]
python3.11 tools/film_assembly_measure.py run --dir $FM/src720 --res 720 --minutes 15 $M \
    --out r720_15_guard.json                      # the guard read ~5 GB free and chose the fast path
python3.11 tools/film_assembly_measure.py run --dir $FM/src1080 --res 1080 --minutes 4 --scenes 60 $M \
    --out r1080_4_compact60.json --assume-free-mb 1
python3.11 tools/film_assembly_measure.py run --dir $FM/src1080 --res 1080 --minutes 10 $M \
    --out r1080_10_compact_filmclock.json --assume-free-mb 1 --narration-clock film

# the final pass's sound alone: 40 s of black, N speech clips, the music bed, optional burned cues
python3.11 tools/film_assembly_measure.py audio-probe --dir $FM/src720 --work $FM/pwork --clips 32 --loudnorm 1
python3.11 tools/film_assembly_measure.py audio-probe --dir $FM/snd1080 --work $FM/pwork --clips 63 --loudnorm 0 \
    --cues 60 [--as-limit-mb 3072]

python3.11 tools/film_assembly_measure.py table *.json
```

`--timeout-s` was left at its default (4 h) so that a slow run finished and was measured; the editor's own budget for the
same length (`timeline.render_timeout_s`: 3 × length + 120 s, at most 5400 s) is in every result next to the wall time.
Every run's media and work folder were deleted after its numbers were recorded.

## Results

### 1. The editor's per-clip loudnorm does not render beyond about 30 clips

The first 10-minute run gave each of the 60 narration clips the editor's `loudnorm: true` (single-pass EBU R128 to -16
LUFS, the only loudness control the engine has). Its 169 segments rendered; its final pass died after 0.6 s:

```
[Parsed_loudnorm_198 @ …] Failed to configure input pad on Parsed_loudnorm_198
Failed to inject frame into filter network: Cannot allocate memory
```

at 435 MB of RSS: the 2 GiB address-space limit, not the container. The final pass's sound alone (`audio-probe`, 720p):

| speech clips | loudnorm | address-space limit | result | final pass peak RSS |
| --: | :-- | --: | :-- | --: |
| 8 | yes | 2 GiB | ok, 11 s | 408 MB |
| 16 | yes | 2 GiB | ok, 11 s | 536 MB |
| 24 | yes | 2 GiB | ok, 11 s | 664 MB |
| 32 | yes | 2 GiB | **Cannot allocate memory** | 722 MB |
| 40 | yes | 2 GiB | **failed** ("Conversion failed") | 599 MB |
| 48 | yes | 2 GiB | **Cannot allocate memory** | 503 MB |
| 63 | yes | 2 GiB | **Cannot allocate memory** | 384 MB |
| 32 | no | 2 GiB | ok, 13 s | 294 MB |
| 63 | no | 2 GiB | ok, 16 s | 308 MB |
| 63 | yes | 3 GiB | **killed at its 600 s deadline**, for a 40 s mix | 973 MB |

Each loudnorm costs about 16 MB of RSS and more address space (it works at 192 kHz); between 24 and 32 of them the final
pass cannot be built under the export's limit, and given more address space it builds and then crawls.

### 2. At 1080p, more than 32 sound clips do not render either

With no loudnorm at all, the 4-minute 1080p film (60 scenes, 61 sound clips: 60 narration + 1 music) rendered its 119
segments (865 s CPU) and then its final pass **crashed after 2.3 s with SIGSEGV** (ffmpeg exit -11), at 526 MB of RSS. The
final pass alone (`audio-probe`, 40 s, no loudnorm):

| frame | sound clips | burned cues | address-space limit | result | final pass peak RSS |
| :-- | --: | --: | --: | :-- | --: |
| 1920x1080 | 63 | 60 | 2 GiB | **stalled, killed at its 600 s deadline** | 499 MB |
| 1920x1080 | 63 | 0 | 2 GiB | **stalled, killed at its 600 s deadline** | 488 MB |
| 1920x1080 | 32 | 60 | 2 GiB | ok, 15 s | 552 MB |
| 1920x1080 | 16 | 60 | 2 GiB | ok, 14 s | 545 MB |
| 1920x1080 | 8 | 60 | 2 GiB | ok, 14 s | 541 MB |
| 1920x1080 | 63 | 60 | **3 GiB** | ok, 19 s | 568 MB |
| 1280x720 | 63 | 60 | 2 GiB | ok, 13 s | 313 MB |

The same command passes at 720p, passes at 1080p with 32 inputs, and passes at 1080p with 63 inputs given 3 GiB: it is
the address space again (every input brings its own demuxer and decoder threads, each a stack reserved under the limit,
on top of a 1080p encoder), and it does not fail cleanly: it hangs until the deadline, or crashes. The captions are not the
cause (63 clips stall with and without them).

Sections 1 and 2 are the same finding: **documents the editor's validator accepts (up to 64 sound clips, any of them with
`loudnorm`) are documents its renderer cannot render under its own limits.** That is an editor bug of its own, not fixed
here (it needs its own PR: a validator limit, or fewer threads per sound input). For films it gives two measured design
rules, which `modules/film_timeline.py` follows: no per-clip loudnorm, and at most 32 sound clips, which a 60-scene film
reaches only with its narration on the film's clock (one clip).

### 3. The films

| film | sound clips | intermediates | wall s | editor budget s | load avg | CPU user + sys s | segments CPU s | final pass CPU s | segment peak RSS MB | cross-fade peak RSS MB | final pass peak RSS MB | cgroup peak MB (with cache) | cgroup RSS MB (sampled) | limit hits | work dir peak MB | output MB | Mb/s | result |
| :-- | --: | :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-- |
| 720p, 10 min, per-scene clock | 63 | fast | 1847 | 1920 | 20.7 | 1199 | not recorded | not recorded | 110 | 155 | 341 | 1374 | 308 | 0 | 1182 | 184 | 2.57 | ok |
| 720p, 15 min, per-scene clock | 64 | fast (guard read ~5 GB free) | 1803 | 2820 | 14.9 | 1835 | 402 | 1433 | 109 | 156 | 350 | 2012 | 337 | 0 | 1777 | 274 | 2.55 | ok |
| 1080p, 4 min (60 × 4 s), per-scene clock | 61 | compact | 739 | 840 | 10.6 | 868 | 865 | 3 | 541 | 401 | 526 | 695 | 528 | 0 | 146 | - | - | **final pass SIGSEGV** after 2.3 s |
| 1080p, 10 min, film clock | 4 | compact | 1483 | 1920 | 4.9 | 3934 | 2059 | 1875 | 543 | 403 | 584 | 1291 | 570 | 0 | 684 | 347 | 4.85 | ok |
| 1080p, 15 min | | | | | | | | | | | | | | | | | | **not measured** |
| 1080p, any length, fast intermediates | | | | | | | | | | | | | | | | | | **not measured** |
| 720p, compact intermediates | | | | | | | | | | | | | | | | | | **not measured** |

Columns: *sound clips* the inputs of the final pass besides the picture; *wall s* the whole render, *editor budget s* what an export of that length is allowed before it is killed
(`render_timeout_s`); *segments CPU s* / *final pass CPU s* user + system time of the children (getrusage, recorded per
command from the second run on); *peak RSS* per ffmpeg from `wait4` as `ffmpeg_limits` reports it; *cgroup peak* the
memory group's high-water mark (page cache included, the number a container limit compares against) and its anonymous RSS
sampled every 0.5 s; *limit hits* `memory.failcnt`; *work dir peak* the render's temp directory at its largest (the
intermediates and the output, which is written there), sampled every second; *output* the file and its average bitrate.
The 720p 10-minute row is the second run of that film (no loudnorm), before the script recorded CPU per command. The
720p runs used the fast intermediates and the 1080p runs the compact ones (the disk, see above), so the two frame sizes'
segment costs are not comparable with each other.

**Core-seconds per output minute** (CPU user + system of every ffmpeg, divided by the film's minutes; the figure that
does not depend on how loaded the machine was):

| film | whole render | segments | final pass |
| :-- | --: | --: | --: |
| 720p, fast intermediates, 10 min | 120 | not recorded | not recorded |
| 720p, fast intermediates, 15 min | 122 | 27 | 96 |
| 1080p, compact intermediates, 10 min | 393 | 206 | 187 |

* **Linear in length.** 720p cost 120 and 122 core-seconds per minute at 10 and 15 minutes; the work directory grew from
  1,182 to 1,777 MB, 1.97 MB per second of film both times (intermediates plus the output).
* **Memory does not grow with length.** The largest single ffmpeg was 341 MB at 10 minutes and 350 MB at 15 (720p), 584 MB
  at 1080p: a quarter or less of the 2 GiB each may have. The memory group's anonymous memory stayed at or under 570 MB of
  4 GiB, `memory.failcnt` stayed 0 throughout, and what the group's high-water mark adds (up to 2,012 MB) is page cache of
  the intermediates, which the kernel reclaims before it would refuse anything. The segment stage holds one decoder per
  process, two in a cross-fade (403 MB at 1080p).
* **The final pass is most of the time at 720p** (78 % of the CPU at 15 minutes) and half of it at 1080p: one libx264
  medium encode of every frame, with the sound mixed and the captions burned in the same pass.
* **The film's loudness is its narration's.** Without a loudnorm the films measured -27.1 (720p) and -27.0 (1080p) LUFS
  integrated: exactly the synthetic narration take's own level, which was never normalised. Nothing in the editor's path
  raises a quiet take, so the take must arrive measured and be corrected (`film_timeline` applies one gain from the take's
  measured loudness and refuses a boost that would clip).
* **The 720p 15-minute run's disk went down to 238 MB free** while it ran, because other sessions wrote to the same disk:
  the guard looks at free space once, before the first segment, and nothing looks again.

**Scaling to the AX42 (8 cores): an estimate, not a measurement.** The 10-minute 1080p film needed 3,934 core-seconds. On
this machine it got 2.65 cores on average (3,934 / 1,483 s) under a load of about 5 on 4 CPUs. The render runs one ffmpeg at
a time and each is capped by `ffmpeg_limits` at two decoder, two filter and four encoder threads, so more cores than about 4
do not make it faster. If the media-worker gets 2.65-4 cores, the same film would take about 3,934 / 4 ≈ 980 s to 3,934 /
2.65 ≈ 1,480 s against its 1,920 s budget. If it gets fewer (its `cpu_shares: 512` is half a default container's weight when
the queue worker's pipeline render runs at the same time, and the host has other services), the margin goes: below about 2
cores (3,934 / 1,920) the editor would kill it at its deadline. A 15-minute 1080p film was not measured, so no number is
given for it here.

## Diagnosis: what fails first

In the order a film would meet them:

1. **The number of sound clips, under the 2 GiB address-space limit, in the final pass.** With a per-clip loudnorm it fails
   from about 24-32 clips at any frame size; at 1080p it fails beyond 32 clips without one. It fails last, after every
   segment has been rendered (865 core-seconds were spent on the 4-minute film before its final pass crashed), and it fails
   badly: `Cannot allocate memory`, or a hang until the deadline (`timed_out` after the full budget), or SIGSEGV. A 60-scene
   film whose narration is cut into one clip per scene is past that line at 1080p. This is the first failure, and it is a
   property of the document, so it can be refused before anything renders.
2. **Wall-clock time against the editor's budget** (`render_timeout_s`, 3 × length + 120 s). Measured at 96 % of the budget
   (720p, 10 min, load 20.7), 64 % (720p, 15 min, load 14.9) and 77 % (1080p, 10 min, load 4.9). It is the next limit under
   contention, and a 1080p film needs about 2 cores for the whole render to stay inside it (estimate above).
3. **Disk.** The fast intermediates take 2 MB per second of 720p film (measured), and the guard asks for 8 MB per second of
   1080p before it uses them (4.8 GB for a 10-minute film). Short of that it silently switches to the compact intermediates:
   a second lossy generation (crf 23 segments re-encoded at crf 23) and a medium-preset encode of every segment, 206
   core-seconds per minute at 1080p. That is a quiet quality fallback in the sense of CLAUDE.md rule 4, and it costs CPU,
   which moves the film towards limit 2.
4. **Memory**, last and far away: at most 584 MB in any ffmpeg and 570 MB of anonymous memory in the group, of 2 GiB and
   4 GiB.

## Recommendation

* **Segment-wise pre-render plus concat: not needed, and `film_timeline` does not emit parts.** The editor's path already
  renders a film one clip at a time and joins the pieces in one final pass, which is why its memory did not grow from 10
  to 15 minutes. Cutting the film into parts rendered apart would not lower the CPU (the work is linear), would give each
  part the budget of its own length (the same ratio), and would make the sound differ at every join (the duck envelope and
  the music fades are computed over the whole film). The only failure that is not a matter of CPU, the sound-clip count,
  is fixed in the document instead:
  - **at most 32 sound clips** (`film_timeline.MAX_SOUND_CLIPS`, measured), and **no per-clip loudnorm**;
  - so the narration take is laid out **on the film's clock** (P3's contract: each scene's words start
    `NARRATION_LEAD_S` into its scene), and `film_timeline` joins it into one clip: the measured 1080p film had 4 sound
    clips;
  - loudness comes from the take, measured (`loudness_lufs`, `true_peak_db`), and is corrected with one gain.
* **Longest film per run: 10 minutes** (`film_timeline.MAX_FILM_S = 600`), the length measured at both 720p and 1080p.
  15 minutes rendered at 720p (64 % of its budget), but not at 1080p, so it is not offered yet. Raise it after a
  15-minute 1080p film has been timed on the media-worker.
* **Temp disk: check it before the render, do not fall back.** P4b should require the guard's own figure, 8 MB per second
  of 1080p film scaled by pixels (4.8 GB for 10 minutes at 1080p, 2.1 GB at 720p), free on the media volume before it
  claims a film, plus the output (347 MB for 10 minutes of the synthetic 1080p film at 4.85 Mb/s, 184 MB at 720p), and
  wait or refuse with that remedy instead of letting `intermediate_x264` switch to the compact path. Measured with the
  fast path: 1.2 GB for 10 minutes and 1.8 GB for 15 minutes at 720p. The 1080p fast path was not measured (this
  container did not have the disk).
* **Separately (not this PR):** the editor's validator accepts documents its renderer cannot render: more than about 24
  sound clips with `loudnorm`, or more than 32 at 1080p. Either the validator gets the measured limits or the final pass
  spends fewer threads per sound input. Until then an editor export of such a document fails after its segments, at the
  end of the user's wait.

## What this did not measure

* The media-worker itself: its CPU, its ffmpeg (Debian's, not 6.1.1: the thread layout per input, and so the address
  space per sound clip, differs between versions), its disk. The first assembly there should be timed against
  `render_timeout_s` before the length limit is raised.
* An upload being checked at the same moment: the media-worker runs at most one upload check beside one export, and Lens
  measured 3,289 MB for the two at their worst (`ffmpeg_limits`). An assembly's own peaks above are small next to that.
* Real provider clips. The synthetic pool brackets the intermediates' size (1.2-5.1 MB/s at 1080p by content), but a
  provider's grain, motion or bitrate could sit outside it.
* 9:16. A 1080x1920 frame has the same pixels as 1920x1080, so the numbers should carry over; it was not run.
* The review copy: a 480p copy of a 10-minute film for the Supabase previews bucket (50 MB per object) is
  `video_review`'s, not this path's (docs/FILM_STUDIO.md).

## Second run: 1080p on the fast path, an idle machine, and the review copy (2026-11-21, P4b)

The P4b assembly worker (`modules/film_assembly.py`) refuses to render when the disk is short for the fast intermediates,
instead of letting `render_backend` fall back to the compact ones. So the fast path at 1080p, "not measured" above, is the
path it takes. It was measured before the worker was built (rule 8).

**The machine.** Again a development container and **not the media-worker**: 4 vCPU, 15.7 GiB RAM, ffmpeg 6.1.1, 60 GB
free on the work disk. This time it was **idle**: the one-minute load was 0.1 before the run and about 2 to 5 during it,
which is the render's own threads. Same 4 GiB cgroup-v1 memory group as above.

```bash
python3 tools/film_assembly_measure.py generate --dir $FM/src1080 --res 1080 --film-s 600
python3 tools/film_assembly_measure.py run --dir $FM/src1080 --res 1080 --minutes 10 --narration-clock film \
    --cgroup $CG --mem-limit 4g --work $FM/work --out r1080_10_fast_film.json --assume-free-mb 100000
```

| film | sound clips | intermediates | wall s | editor budget s | segments wall / CPU s | final pass wall / CPU s | CPU user + sys s | segment peak RSS MB | cross-fade peak RSS MB | final pass peak RSS MB | cgroup peak MB (with cache) | cgroup RSS MB (sampled) | limit hits | work dir peak MB | output MB | Mb/s | result |
| :-- | --: | :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-- |
| 1080p, 10 min, film clock, 60 scenes, 180 burned cues | 4 | fast | **718** | 1920 | 187 / 398 | 530 / 1619 | 2017 | 159 | 253 | 572 | 2865 | 535 | 0 | 2260 | 354 | 4.95 | ok |

* **202 core-seconds per output minute** on the fast path at 1080p, against 393 on the compact path (the 1080p row
  above): the fast intermediates halve the CPU, and the segments drop from 206 to 40 core-seconds a minute. The final
  pass (one libx264 medium encode with the mix and the burned captions) is 80 % of the CPU.
* **Wall time: 37 % of the editor's budget** on an idle 4-vCPU machine. The render ran on about 2.8 cores on average
  (2017 / 718). It needs about 1.05 cores for the whole film to stay inside its 1920 s budget (2017 / 1920), against
  about 2 on the compact path. This is still not the media-worker, and the owner's timed run there stays owed.
* **Disk: 2,260 MB at the peak**, which is 3.8 MB per second of film, intermediates and output together. The worker
  asks for 8 MB per second scaled by pixels, plus 1 MB per second for the output (5.4 GB for 10 minutes of 1080p): about
  2.4 times what was used, on purpose. Detailed real footage makes bigger intermediates than these synthetic clips
  (6.2 MB/s, `render_backend`), and nothing re-checks the free space during the render.
* **Memory, unchanged:** at most 572 MB in any one ffmpeg, 535 MB of anonymous memory in the group, and `failcnt` 0. The
  group's high-water mark of 2,865 MB is page cache of the intermediates (reclaimable), under the 4 GiB.

**The review copy.** The assembly's review copy is the library's own 480p proxy of the registered master
(`media_library.proxy_command`: libx264 veryfast crf 28, AAC 96 kb/s), made by `store_generated`. Measured on a
600 s 1080p master of the same twelve clips in turn, with the narration:

| master | proxy | wall s | CPU s | peak RSS MB | size | video kb/s | the library's time limit for it |
| :-- | :-- | --: | --: | --: | --: | --: | --: |
| 1920x1080, 600 s, 587 MB | 854x480 | 66 | 155 | 128 | **22.1 MB** | 197 | 1,087 s |

That is 44 % of the 50 MB Supabase object ceiling, **for synthetic content**. crf 28 spends bits on detail, so real
provider footage could give a larger proxy, and that was not measured. The worker therefore checks the proxy's size after
storing the master. Above 50 MB it fails the assembly by name (`review_copy_too_large`) rather than keep a review copy
that cannot be uploaded. If real films reach that limit, the remedy is a bitrate-capped review encode (about
`45 MB × 8 / length − 96 kb/s`, which is 504 kb/s for 10 minutes), not a smaller film. Real films did reach it (49.37 MB
at 10 minutes, docs/studio/S4_GAPS.md G2), so the film's review copy is now encoded with that cap
(`film_assembly.review_maxrate_kbps`); `review_copy_too_large` remains only as the guard behind it.

**A/V sync,** checked on a real render of fixture clips (`tests/test_film_assembly.py`): a white flash in scene 1's clip
and a beep placed at the same film time in the narration land within 50 ms of each other in the output. The narration's
0.25 s lead shows up as the audio stream's `start_time` (0.228 s), not as leading silence samples. A check that counts
samples from the start of the stream reads the audio as 0.23 s early. It is in sync; measure on the file's clock.

## Running it on the media-worker (owner step)

On the server, in the deploy directory, with nothing else rendering. It writes only under the media volume's
`.film-measure` folder and removes it; nothing reaches the database or the library:

```bash
docker compose --profile worker run --rm --entrypoint bash media-worker -c '
  FM=/app/media/.film-measure
  python tools/film_assembly_measure.py generate --dir $FM/src1080 --res 1080 --film-s 600 &&
  python tools/film_assembly_measure.py run --dir $FM/src1080 --res 1080 --minutes 10 --narration-clock film \
      --work $FM/work --out $FM/r1080_10.json
  cat $FM/r1080_10.json; rm -rf $FM'
```

The container is itself the 4 GB limit, so `--cgroup` is not needed there, and the guard reads the real volume.
