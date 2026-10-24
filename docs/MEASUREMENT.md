# Measurement and the publish gate (Phase 6)

Phase 6 answers four questions the project could not answer before:

1. **What does a video cost?** Nothing recorded cost — there was no column for
   it anywhere.
2. **Which thumbnail and title actually work?** Both variants were generated on
   every run; only A ever shipped, so the experiment was thrown away before it
   ran.
3. **Where do viewers leave?** `averageViewDuration` said *how long* they
   watched. Nothing said *where* they stopped, which is the part a script can
   fix.
4. **What stopped a bad video?** The quality checks reported and were ignored;
   the upload happened regardless.

One rule runs through all of it: **null is not zero.** An unpriced unit is not
free, an unpolled video has unknown click-through, and a video with no curve has
unknown retention. Every aggregate excludes those and says so, rather than
averaging in a zero that would quietly become a fact.

---

## 1. Cost ledger

`modules/cost_ledger.py` · table `video_costs`

The ledger records **quantities**, which the pipeline observes:

| Unit | Recorded at |
| --- | --- |
| `gemini_input_tokens`, `gemini_output_tokens` | every Gemini call that reports usage |
| `tts_characters` | narration synthesis |
| `render_seconds` | wall-clock time of the compositor |
| `pexels_requests` | stock-footage fetches |
| `upload_bytes` | the uploaded file's size |

A **dollar figure is not observed**. Unit prices differ per vendor plan and
change without notice, so a price is applied only when the operator configures a
rate:

```bash
CHRONOS_PRICE_GEMINI_INPUT_TOKENS=0.000000075   # USD per single unit
CHRONOS_PRICE_TTS_CHARACTERS=0.000016
CHRONOS_PRICE_RENDER_SECONDS=0.0002
```

With no rate set, `estimated_usd` stays NULL and the Command Center's
**Measurement** page names the exact `CHRONOS_PRICE_*` variable to set. A video
whose entries are *partly* priced reports no total at all — a partial sum would
understate the real cost and read as if it were the whole thing.

Recording a cost can never break a video: like `event_log`, every method
swallows its own failures. A run that fails part-way still records what it had
bought (`main.run` flushes the ledger in a `finally`), and the queue worker
mirrors its `history/chronos.db` costs to Supabase `video_costs` after every job
(`SupabaseSync.mirror_costs`, idempotent through the `row_key` of migration 0106).

**Hard USD caps** (`modules/spend_guard.py`). Two repository *variables*, both
reaching the worker through `deploy/.env.worker.example` ("Deploy web" applies a
change): `CHRONOS_MAX_RUN_USD` (default 10) stops a run, with a message naming the
variable, before the next stage that buys something (the topic, the voice,
generated clips, generated stills, the avatar presenter) once its ledger is over
the cap, counting the clips and stills it is about to submit; `CHRONOS_MAX_DAILY_USD` (default 30) does the same for the operator's
own organisation when today's (UTC) ledger on that worker is over it. `off` removes
a cap; zero or text that is not a number keeps the default. The caps see only
priced units, so set the `CHRONOS_PRICE_*` variables for every unit you buy
(`gemini_input_tokens`, `gemini_output_tokens`, `tts_characters`, `video_gen_clips`,
`image_generations`, `render_seconds`, ...); the deploy log and the run log warn
when none are set.

The fal.ai presenter (`NIGHTSHIFT_AVATAR_PROVIDER=fal`) is counted: its worst case
(seconds x `NIGHTSHIFT_AVATAR_FAL_USD_PER_SECOND`, default 0.06, plus the portrait)
is added to the cap check before it is bought, and what fal reports it billed is
written to the ledger as an estimate (`avatar_seconds`, stage `avatar:fal`). It also
has its own ceilings, checked before any request: `NIGHTSHIFT_AVATAR_MAX_SECONDS`
(default 30, never above 60) and `NIGHTSHIFT_AVATAR_MAX_USD`.
The seconds are ledgered as soon as fal says the request is COMPLETED (before the result
is fetched), so a failed download never leaves paid work unrecorded; a request whose
submit answer was lost, or that timed out while running, is recorded at the planned
amount with stage `avatar:fal:unconfirmed` (it may not have been billed). fal's CDN is
public by link: uploads ask for a one-hour expiry via the documented lifecycle header,
which has not been verified against the live service.

**Not covered by the caps:** the Higgsfield presenter clip's own price (it
has no ledger unit, so only a stop before it on earlier spend), the advisory vision
critic (it runs after the render; it keeps its channel ceiling), scene regeneration
jobs (priced and held on their own), and Creative OS jobs (own price and hold).

**Privacy of the mirror.** The worker's copy of `video_costs` in Supabase carries
`estimated_usd` only for the operator's own channels; a customer channel's rows keep
units, quantities and stage but a NULL USD (what a provider charges is the
operator's margin). This holds for both mirror paths: the worker's
(`SupabaseSync.mirror_costs`) and the Actions intelligence poll's
(`mirror_from_store`, called from `tools/run_intelligence_poll.py`), which decide
"the operator's own channel" from the channel registry (`is_operators`). A channel
that cannot be looked up at that moment has its cost rows skipped until it can (a
row sent with a wrong NULL would stay NULL: Supabase ignores duplicates); a
caller that gives no test sends no USD at all.

## 2. Thumbnail and title A/B

`modules/ab_testing.py` · columns `videos.thumbnail_variant`, `videos.title_variant`

Selection alternates by the channel's published-video count (even → A, odd → B),
which is deterministic, needs no extra state, and fills both arms evenly. The
chosen arm is stored on the video, so the result is readable back.

Reading it back (`variant_performance`) compares mean `impression_ctr` from
`metrics_snapshots` and **refuses a verdict** below either floor:

* `MIN_PER_VARIANT = 5` measured videos **per arm**
* `MIN_LIFT = 0.10` relative difference

A video whose CTR was never measured is excluded, not counted as 0. Once there
is a verdict, `choose_variant` favours the winner but still ships one video in
`EXPLORE_EVERY = 5` on the other arm — a thumbnail style that worked in June is
not guaranteed to work in December, and an experiment that stops running stops
being able to tell you.

The dashboard mirrors these constants in `command-center/lib/measurement.ts`.
**Change one, change both** — the dashboard must not name a winner the pipeline
would not act on.

## 3. Audience retention

`modules/retention_analyzer.py` · table `retention_points`

`analytics_client.video_retention()` queries `audienceWatchRatio` across the
`elapsedVideoTimeRatio` dimension, and the Intelligence Poll stores one row per
measured point. `RetentionAnalyzer.as_prompt_text()` turns the stored curves
into two facts the script engine can act on:

* whether the **hook** holds (retention through the first `HOOK_RATIO = 10%`),
* where the **largest cliff** starts, when any drop clears `MIN_CLIFF_DROP`.

Below `MIN_CURVES = 3` usable curves (each needing `MIN_POINTS = 5` points) it
returns `""`, so appending it to a prompt is always safe and one video's story is
never mistaken for a pattern.

### Per scene

`modules/scene_retention.py` · twin `command-center/lib/sceneRetention.ts` ·
shared cases `samples/scene_retention_cases.json`

The newest curve is placed on the Video IR's real scene windows
(`videos.manifest`, migration 0013): a point at `elapsed_ratio` sits at
`elapsed_ratio × audio duration` seconds, and the rendered video is exactly the
audio's length. Each scene gets retention at its start and end (linear
interpolation between measured points), the drop, the drop per minute, and a
rank on that rate — a long scene loses more simply by being long. It is computed
on read; nothing new is stored.

Unknown stays unknown: no real scene times, no known duration, or fewer than
`MIN_POINTS` measured points give `null`, never 0. The curve is never
extrapolated, and YouTube reports it from 1% of the video onwards, so the first
scene's start retention (and therefore its drop) is unknown.

The video page's Storyboard shows each scene's numbers and highlights the three
fastest-losing scenes; without data it shows one neutral note saying why. The
learning memory proposes a **pending** retention learning when a scene type or
shot recipe loses viewers at ≥ 1.4x (or ≤ 0.6x) the channel's median scene rate,
only with at least `MIN_CURVES` videos of scene data on the channel and
`MIN_CURVES` distinct videos in that group. Nothing reaches a prompt until an
admin approves it.

### Diagnosis: which lever the curve points at

`modules/retention_diagnosis.py` · fixture `samples/retention_diagnosis_cases.json`
(shared with a future TypeScript twin)

The analyzer says *how much* of the hook survives and the per-scene map says
*where*; neither says what to change. The diagnosis reads one video's newest
curve (`scene_retention.clean_curve` / `interpolate`, duration from
`scene_retention.video_duration`) and routes to one lever. It is **read-only and
not wired anywhere yet** — it feeds no prompt, no gate and no event. Wiring it
(the poller does not have the manifest at the point it stores the curve) is a
later PR; so is any change to `RetentionAnalyzer.as_prompt_text` or `HOOK_RATIO`,
which needs its own measurement PR.

| Finding | Definition |
| :-- | :-- |
| **Hook leak** | Audience lost over the first `HOOK_WINDOW_S = 30` **absolute** seconds (`HOOK_RATIO` is 10% of the video, so it means 60 s on a 10-minute video and 3 min on a 30-minute one). Reported as `hook_loss` (audience points) and `hook_loss_share` (the same loss as a share of viewers still watching where the window starts). Measured from the **first measured point** (`hook_from_s`; YouTube's curve starts at 1%, 6 s into a 10-minute video), never from an invented 100% at 0 s, so it is a lower bound when that point is later than 0 s. Unknown when the curve starts less than `MIN_HOOK_SPAN_S = 10` s before the window end or does not reach 30 s. |
| **Cliffs** | Up to `TOP_CLIFFS = 5` steps between adjacent measured points that lose at least `CLIFF_MIN_DROP = 0.03` audience points **and** go at least `CLIFF_RATE_MULTIPLE = 4` times faster per minute than the curve's median step (so 100 points and 20 points give the same answer, and noise on a flat curve is not a cliff). Ranked by rate, then size, then earliest. Each carries its timestamp, size, retention before/after, a `zone` (`hook`, `mid`, `end` = last 20%), the Video IR scene holding the step's midpoint and an excerpt of that scene's narration. |
| **Slide** | Average loss across the middle: `(R(30 s) - R(80% of the video)) / span`, an endpoint average, not a fit; negative when the curve rises. `slide_per_min` per minute and `slide_per_tenth` per 10% of the video's length. Thresholds read the per-tenth value: per minute a 60-minute video always looks flat beside a 5-minute one. Unknown when the span is under `MIN_SLIDE_SPAN_S = 30` s (videos under 75 s) or the curve does not cover it. |

The excerpt is the **opening of the scene's narration**, not the exact words at
the moment: the Video IR stores no word timings, and guessing a position inside
a scene from character counts would be an assumption presented as a quote. It is
text only (tags, `[DIRECTIVES]` and markdown punctuation removed, control
characters and runs of whitespace collapsed), capped at `EXCERPT_MAX_CHARS = 120`
including the ellipsis, in whatever language the narration is — no word lists.

**Verdict**, a closed set, first rule that holds:

| Verdict | When | Lever |
| :-- | :-- | :-- |
| `hook` | `hook_loss_share >= HOOK_STEEP_MIN_LOSS` (0.45) | rewrite the opening |
| `pacing` | `slide_per_tenth >= SLIDE_STEADY_MIN` (0.05), or a cliff in the middle of the video | cut or repair the scene(s) the cliffs name |
| `packaging` | hook known and `<= HOOK_HEALTHY_MAX_LOSS` (0.30), slide known and `<= SLIDE_FLAT_MAX` (0.02), no mid-video cliff | viewers who click stay: the title / thumbnail promise is the lever |
| `healthy` | hook and slide known, nothing crossed a threshold, but not clean enough for `packaging` | none |
| `insufficient_data` | no usable curve (under `MIN_POINTS`), no known duration, or a hook/slide that cannot be measured and nothing else decides | none — `reason` says which |

A hook or slide that cannot be measured is never read as fine: a missing piece
can never become `packaging`. Every unknown value is `None` (`cliffs` is `None`
when they could not be looked for, `()` when none qualified), never 0. The
thresholds are starting points of our own, not calibrated on this channel's
history; they are module constants so a measurement PR can move them.

## 4. The pre-publish gate — **this changes publish behaviour**

`modules/publish_gate.py` · events `publish.blocked`, `publish.allowed`

Until Phase 6 the originality check was never called from `main.py`, and the
fact-check only wrote a report. The gate now runs **before the upload** and can
stop it:

| Check | Blocks when |
| --- | --- |
| sanity | no title, title over 100 characters, video file missing or under 100 KB, fewer than 2 script sections |
| fact-check | the fact-checker returned failing claims (the Wikipedia lookup of `docs/GROUNDED_FACTCHECK.md` can clear a claim with a verified quote or add a flag; its outage is only the warning `grounding_unavailable`) |
| originality | the topic duplicates an already-published video |
| rights | an asset a scene actually uses has `rights.status == "blocked"` in the Video IR (`unknown` only warns — see below) |

Three deliberate properties:

* **It only ever blocks.** There is no path where the gate causes a video to be
  published that would not have been published before.
* **A broken checker warns, never blocks.** If a check itself raises, the video
  ships and the failure is recorded as a warning — an outage in a checker must
  not become an outage in publishing.
* **`--no-upload` is unaffected.** The gate runs and reports; nothing was going
  to be uploaded anyway.

### Turning a check off for one channel

`channels.agent_config.publish_gate` on that channel:

```json
{ "publish_gate": { "block_on_duplicate": false } }
```

The four keys are `enabled`, `block_on_sanity`, `block_on_fact_check` and
`block_on_duplicate` (the originality check). Only an **explicit `false`**
disables one. A missing key, a null, a typo, or `"false"` as a string all leave
the check on — a misconfiguration must fail
towards checking, not towards publishing. `{"enabled": false}` turns the whole
gate off for that channel, which restores exactly the pre-Phase-6 behaviour.

`block_on_rights` (same rule, default on) governs used assets whose rights are
`blocked`. One key works the other way round: `block_on_unknown_rights` is
**off** unless it is an explicit `true`. Until provenance is recorded almost
every asset is `unknown`, so by default unknown rights produce a
`rights_unknown:<count>:<scene ids>` warning, not a block. No Video IR for the
run is a `rights_check_not_run` warning; the counts ride in the event's
`rights` metadata (asset and scene ids only, no paths).

Every decision is emitted as an event carrying the gate's **own reason strings**
— never script text, claim text, or anything that could carry a credential.

---

### How the ledger reaches the dashboard

The nightly mirror (`modules/supabase_sync.py`) sends the local `video_costs` rows
to Supabase. Each carries a deterministic `row_key` (migration 0106) and is
written with ignore-duplicates, so re-sending the whole history every night adds
nothing (sent in chunks of 2000; the log's count is rows sent, not rows inserted),
while two charges that really are identical (same flush, same stage,
same quantity) stay two. A database without the migration refuses the write; the
mirror then skips the table for that run and says so in its log, because a plain
insert would duplicate every row. The owner's per-provider spend is read with
`owner_provider_spend(days)`.

## 5. Applying the migration

`supabase/migrations/0002_measurement.sql`, run in the Supabase SQL editor.
Additive only: two new tables, four new nullable columns, no drop, no rename, no
delete. Every added column is nullable with no default, because "not measured"
and "measured as zero" are different facts and the schema has to be able to tell
them apart. A fresh project needs only `supabase/schema.sql`, which inlines the
same statements.

RLS posture is unchanged: both new tables are RLS-on, `select` to `authenticated`
only, with no write policy. The anon key alone still reads nothing.

## 6. Where to look in the Command Center

**Measurement** (`/measure`), scoped by the channel switcher like every other
page:

* cost per video, with unpriced units surfaced as the `CHRONOS_PRICE_*` to set;
* the A/B arms, their measured CTR, and the verdict or the reason there isn't one;
* the averaged retention curve, its hook figure and its cliff;
* recent gate decisions and what each one blocked on.

`retention_points` and `metrics_snapshots` carry no `channel_id` of their own —
they belong to a video, so the page scopes them by the videos in the current
selection rather than by weakening the query.

## 7. Packaging lint (advisory, uncalibrated)

`modules/packaging_lint.py` · event `packaging.lint` · no switch, no migration

Reads the title that will really ship (`published_title`, so the B arm's title when B ships) and the
script's `thumbnail_overlay_text`, and records one event per run. It changes nothing: not the title,
the thumbnail, the gate, the upload or the privacy. A failure in it is logged at debug and the run
carries on. The Command Center has no card for it yet; the event sits in `system_events` next to
`publish.score`, which needs no registry entry.

Each check is `ok`, `issue` or `not_checked`, with a reason from a closed list. The event carries
counts and those words only, never the title or the overlay text.

| Check | What it looks at | Language |
| :-- | :-- | :-- |
| `title_mobile_cut` | more than 40 visible characters (cut in a phone feed) | any |
| `title_desktop_cut` | more than 60 visible characters (cut in desktop search) | any |
| `title_hard_limit` | more than 100 characters, counted like the publish gate counts them | any |
| `figure_position` | the first digit sits past the mobile or desktop cut, so the number is the part that is lost | any |
| `title_caps` | more than 2 words of 3+ capital letters | any script with case |
| `overlay_length` | thumbnail text over 4 words or 28 characters | any |
| `overlay_echo` | at least half of the overlay's content words are already in the title | **English only** |

* **What survives a cut** is the head: the first 40 (phone) or 60 (desktop) glyphs. `figure_position`
  says whether the number is among them. "Visible characters" are glyphs, not code points, so an
  emoji sequence, a combining accent or an Uzbek `o'` counts once; the 100 limit is the exception and
  counts code points because that is what the gate (and the API) count.
* **Unknown is not ok.** No overlay text (the script left it empty) makes both overlay checks
  `not_checked: no_overlay` and their counts `null`, never 0. A title with nothing to measure, a title
  with no letters that have a case, and an overlay of only function words are `not_checked` too.
  Note that `main.py` still ships a placeholder word when the overlay is empty; the lint reports the
  script's field, so it says "unknown", not that the placeholder was checked.
* **Language gate.** `overlay_echo` needs a function-word list, which exists for English only. For
  Russian, Uzbek, any other language, or none, it is `not_checked: language`, never `ok`. The event
  states `word_checks: language` when that happened. The other checks read characters and run for every
  language.
* **Uncalibrated.** The 40/60/100 cut points are the commonly reported ones (the real cut is by pixel
  width, so wide letters are cut earlier); the 2-caps, 4-word and 28-character budgets and the one-half
  echo share were chosen by hand and not fitted to this channel's CTR. The event says
  `basis: heuristic`, `calibrated: false`. Use it to see how many past titles are cut before changing a
  prompt, not as a verdict. Acronyms of 3+ letters (NASA) count as capitals.

---

# Shorts

`modules/shorts.py` · migration `0003_shorts.sql`

A Short is **derived from the long video that already published**, not rendered
a second time. A second render would double the most expensive stage of the
pipeline for a 30-second clip and would produce different cuts, different Ken
Burns timing and different subtitle placement — the Short is meant to be a
trailer for the long video, so it is cut from the long video.

## The frame

A 16:9 frame does not become 9:16 by cropping: a centre crop throws away two
thirds of the width, and this project's subtitles are laid out nearly
full-width, so cropping would slice words in half. Instead the whole frame is
scaled to 1080 wide and centred on a 1080×1920 canvas, on the compositor's own
background colour. Nothing in the frame is lost.

## The window

The **hook** — the opening section the script engine wrote specifically to stop
a scroll — cut on the audio mixer's own measured section boundary, clamped to
15–60 seconds. That needs no guessing about which moment is "best": it is the
part of the script that already has that job. A timeline that says nothing
usable produces no Short rather than a guessed one.

## Cost, and why it is off by default

**A Short is a second `videos.insert`: about 1,600 more quota units out of the
10,000 a day.** Publishing one every day roughly halves how many long videos the
same Google Cloud project can carry. So Shorts are opt-in per channel, and only
an explicit `true` turns them on:

```json
{ "shorts": { "enabled": true, "max_seconds": 45 } }
```

in that channel's `agent_config`. A missing key, `"true"` as a string, or a typo
all leave Shorts off — nothing starts spending quota because a value was
misread.

## What it can and cannot break

The Short runs **strictly after** its long video has published, which means the
publish gate has already passed and the video is out. Every step from there is
best-effort: a missing moviepy, an unreadable source, a failed upload — each is
logged as `short.failed` and returns. **No failure in this path can turn a
successful run into a failed one.** There is also no A/B arm on a Short: it
ships the long video's own frames, so attributing a thumbnail variant to it
would double-count the experiment.

## Where it lands

The Short is its own row in `videos` — its own YouTube id, its own metrics, its
own retention curve — with `video_format = 'short'` and `parent_video_id` naming
the long video it was cut from. Everything published before migration 0003 is
`'long'`, which is a fact about the history rather than an assumption written
over it. The Command Center's video library marks Shorts with a badge.
