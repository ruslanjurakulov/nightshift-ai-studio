# Video go-live checklist

Plain steps to get the first real video out of the server worker, in the order that
wastes the least money. Each step says what to set, where, and how to see that it
worked. The one command that checks most of this for you is the **doctor**
(section 6) - run it after every change.

## Two rules to remember

1. **Keys are GitHub Secrets. Switches and choices are GitHub Variables.**
   Put both at repository level (Settings > Secrets and variables > Actions) so
   the daily workflow and the "Deploy web" job (environment `production`) both see
   them. A key stored as a Variable is silently ignored: the worker gets an empty
   value. Names are exact and case-sensitive.
2. **After any change, run Actions > "Deploy web" > Run workflow.** The worker reads
   `/opt/nightshift/.env.worker`, which is written by that job. Until you redeploy,
   the worker keeps the old values. Only names listed in
   `deploy/.env.worker.example` can reach the worker at all.

Never paste a key into chat, an issue, a commit or a log. The doctor never prints
one either: it says only "set" or "missing" and describes the problem in words.

## 1. Accounts to fund or create

| Account | Why | What you need from it |
|---|---|---|
| Google AI Studio (Gemini) | topic, research, script, fact-check | billing or prepay on the project that owns the key |
| ElevenLabs | the narration voice | a plan that allows API use, and enough characters (about 900 characters per minute of narration) |
| Pexels | stock footage and photos | a free API key |
| Supabase | queue, credits, storage | the project's URL and its `service_role` key |
| YouTube / Google Cloud | upload | an OAuth client, an authorised channel token, and the channel id. The OAuth consent screen must be **published**, not left in "Testing" (Testing tokens expire after 7 days). The API allows 10,000 units a day; an upload costs about 1,600, captions about 400 |
| One AI-video provider (optional) | generated clips, at most 2 per video | pick ONE to start: Kling, Veo, Seedance, Wan or MiniMax (see section 3) |
| An AI-image provider (optional) | generated stills, at most 2 per video | Leonardo, OpenAI, Gemini, Black Forest Labs, Ideogram or fal |

A provider's dashboard is the only place that shows its balance for most of the
paid ones (only ElevenLabs and Leonardo can be read by key). Look at them yourself
during the first week.

## 2. The minimum for one real video (stock footage)

**Secrets**

| Name | Notes |
|---|---|
| `SUPABASE_URL` | the project URL, starts with `https://` |
| `SUPABASE_SERVICE_KEY` | the `service_role` key. Worker only, never the web app |
| `GEMINI_API_KEY` | |
| `PEXELS_API_KEY` | a dead or wrong key makes a black video, so the doctor checks it |
| `ELEVENLABS_API_KEY` | not needed if you choose the free voice (below) |
| `YOUTUBE_CLIENT_SECRET_JSON` | the whole `client_secret.json`, pasted on one line |
| `YOUTUBE_TOKEN_JSON` | the whole `youtube_token.json` |
| `YOUTUBE_CHANNEL_ID` | |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | only for customers connecting their own channels |

**Variables**

| Name | Value |
|---|---|
| `NIGHTSHIFT_WORKER` | `on` (starts the worker on deploy) |
| `NIGHTSHIFT_CREDITS_ENFORCE` | `on` (also set it in the web environment) |
| `TTS_PROVIDER` | `elevenlabs`, so a missing key can never become the free robot voice. Use `edge` only if you want the free voice on purpose |
| `ELEVENLABS_VOICE_ID` | a 20-character id copied from the account's own voice list (a plain number is not an id) |
| `ELEVENLABS_SECONDARY_VOICE_ID` | a 20-character id, or the word `narrator` |
| `ELEVENLABS_MODEL_ID` | optional; default is `eleven_multilingual_v2` |
| `NIGHTSHIFT_CREATIVE_WORKER` | `on` only if you use the Creative Studio |

The web server's own environment also needs `NIGHTSHIFT_RUN_BACKEND=queue`, so "Run
now" queues the job for the worker instead of starting a GitHub workflow. Keep
`YOUTUBE_PRIVACY` at `private` (it already is): nothing here publishes on its own.

**In the database**

- Every migration in `supabase/migrations/` applied, in order (`docs/MIGRATIONS.md`).
  The doctor can only probe a few of them (0012, 0016, 0017, 0020, 0045, 0106,
  by checking that their tables and columns exist); it cannot tell you the rest
  are applied, so check the others in the Supabase dashboard yourself.
- The private Storage bucket `previews` exists (migration `0004`).
- Prices set in the Command Center under Owner > Prices: `video_minute` and
  `job_minimum`, plus the unit rows `tts_characters`, `video_gen_clips`,
  `image_generations`, `gemini_input_tokens`, `gemini_output_tokens` and
  `render_seconds`. For the public API, the same two names under API prices.
  Without prices every run is refused with `credit_estimate_unavailable`.

## 3. Optional: AI video clips (choose one first)

Set the Variables `CHRONOS_VIDEO_PROVIDER` and `CHRONOS_ENABLE_VIDEO_GEN=true`,
then the provider's key:

| `CHRONOS_VIDEO_PROVIDER` | Secret(s) | Also |
|---|---|---|
| `kling` | `KLING_ACCESS_KEY` + `KLING_SECRET_KEY` (or `KLING_API_KEY`) | fund the international (Singapore) Kling API |
| `veo` | `VEO_API_KEY` | a Gemini key on a paid tier with Veo access |
| `seedance` | `SEEDANCE_API_KEY` | activate the model in the BytePlus ModelArk console |
| `wan` | `WAN_API_KEY` | Variable `WAN_WORKSPACE_ID`; use an international key |
| `minimax` | `MINIMAX_API_KEY` | Variables `CHRONOS_ENABLE_MINIMAX_BROLL=true` **and** `MINIMAX_H3_MODEL=MiniMax-Hailuo-2.3` (the default H3 model needs a path nobody has confirmed) |

Do not use `higgsfield` for clips yet: its connection details are unconfirmed.

## 4. Optional: AI stills and Studio models

- Stills: Variables `CHRONOS_IMAGE_PROVIDER` (`leonardo`, `gpt-image`,
  `nano-banana`, `flux`, `ideogram` or `fal`) and `CHRONOS_ENABLE_IMAGE_GEN=true`,
  with the matching Secret: `LEONARDO_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`, `BFL_API_KEY`, `IDEOGRAM_API_KEY` or `FAL_KEY`. A generator
  that fails still falls back to stock photos, so read the first run's log.
- Creative Studio models take their own vendor's key (listed in
  `deploy/.env.worker.example`). Probe each model once, then set it beta or live
  in the Models screen.
- **Do not run the "Probe models" workflow with an empty model field.** It makes
  one paid call for every model that has a key (about 45). Probe one model id at a
  time: `python tools/probe_models.py --model <id>`.

## 5. Smoke test, in this order

Each step is small and cheap. Do not skip ahead: the earlier steps catch the cheap
mistakes before a paid step can waste money.

1. **Deploy**, then run the doctor (section 6). Fix every FAIL. Re-run until it
   says `READY: YES` or only warnings you understand.
2. **Operator channel, "Run now", 30 seconds, privacy private, no AI clips.**
   Expect: the job goes queued > running > succeeded; the narration is the voice you
   chose; the picture is not black; a preview plays (a video that was not uploaded
   may have none yet - see the run's page).
3. **Repeat with one AI clip provider on.** Check the provider's own dashboard
   shows exactly the number of clips you expected (at most 2).
4. **A customer organisation with a few credits.** Run once and follow the credits:
   hold, then capture, then the balance. Then run one that is meant to fail (for
   example a topic that is too long): the hold must be released.

## 6. Run the doctor

The doctor is read-only. It makes no paid call and changes nothing: it compares what
you asked for with what the worker really has, checks each key for "set" and for
how it is written, calls a provider only where a free, authenticated check already
exists in this repository, and checks the database, the worker's heartbeat, disk and
tools. Anything it cannot prove for free is reported as `UNVERIFIED` rather than
`PASS`; the provider your configuration actually selects counts as a warning,
so the report never reads "ready" on a key nobody has proven.

On the server (the `dc` shortcut is defined in `docs/DEPLOY_AX42.md`; spelled out it
is `docker compose --env-file /opt/nightshift/.env.web -f /opt/nightshift/app/deploy/docker-compose.yml`):

```bash
cd /opt/nightshift/app
dc --profile worker exec worker python tools/doctor.py            # human report
dc --profile worker exec worker python tools/doctor.py --json     # machine-readable
dc --profile worker exec worker python tools/doctor.py --offline  # configuration and host only, no network (never "ready")
# the same thing without compose, using the container name:
docker exec nightshift-worker-1 python tools/doctor.py
```

It must run inside the worker container: that is the only place that sees the
environment the worker really has. It exists in the image once the change that adds
`tools/doctor.py` has been deployed.

**Scheduled too.** `.github/workflows/doctor_scheduled.yml` runs the same read-only
checks every 6 hours (`tools/doctor_report.py`) and reports the failing ones to the
operator bot, so a rejected YouTube refresh token or a dead provider key arrives as an
alert instead of as a day with no video (docs/operator-bot.md, "Reliability
alerts"). It sees the configuration GitHub holds (the secrets and variables the daily
run is given), not the worker container's own environment, which is refreshed by each
deploy; the `host` checks (disk, ffmpeg) belong to the machine and are not judged
there. Run the doctor in the container, as above, after a deploy.

Reading the report:

```
READY: NO (2 blocking, 1 warning)
[FAIL] pexels   search check: Pexels refused the key
                next: create a new key at pexels.com/api, update the secret PEXELS_API_KEY, then Deploy web
[WARN] narration voice   ELEVENLABS_API_KEY is empty and TTS_PROVIDER is unset: ...
[PASS] supabase  reachable, service key accepted
[ -- ] other providers   key present, no free authenticated endpoint ...: kling, fal
```

- `FAIL` blocks a good run. `WARN` is probably a mistake. `PASS` is proven.
  `UNVERIFIED` is "present but only a real (paid) call can prove it". `SKIP` was not
  checked.
- Every line that is not a pass ends with the exact next step.
- Exit code: `0` ready, `1` something blocking, `2` warnings only, nothing could be
  checked, or `--offline` (that run says `CONFIG ONLY` and is not a readiness answer).
- Gemini is checked with a free model lookup (the key is sent in a header, nothing
  is generated). `--no-youtube` skips the YouTube token refresh, which is a free
  request whose result is held in memory and not saved.
- The narration lines describe the deployment default. A channel can pick its own
  voice in the Command Center; the doctor does not check per-channel overrides.
- A variable that holds something it should not (for example a key pasted into
  `TTS_PROVIDER`) is reported as "an unrecognised value", never repeated.
- The idle pipeline worker leaves no heartbeat, so with no job in flight the report
  says `UNVERIFIED` for liveness. Check `dc --profile worker ps worker` shows it
  `running`; the smoke run is the proof.

**Repo side (are the names in GitHub?)** needs a fine-grained token with read-only
"Secrets" and "Variables" access. It is not available inside the worker, so run it
from a checkout on your own computer:

```bash
GITHUB_TOKEN=... python3 tools/doctor.py --github --repo ruslanjurakulov/nightshift-ai-studio
```

It lists **names only** (a variable's value is never read or printed) and flags: a
required name that is missing, a key stored as a Variable, and anything changed
after the last successful "Deploy web" (the worker may still hold the old value).
Without a token it prints `SKIP` and does nothing.

## 7. Keeping the server healthy

- **Disk.** The doctor reports the free space on the output volume (FAIL under
  5 GB, WARN under 10 GB). A run now refuses to start under the same 5 GB, before
  it spends anything: `main.py` calls `modules/disk_guard.py`'s `require_free_disk`
  right after the credential check, and the job fails with the sizes and the fix
  (the customer reads "The video could not be put together", nothing is charged).
  Set the Variable `NIGHTSHIFT_MIN_FREE_DISK_GB` (then Deploy web for the server
  worker; the daily workflow and the render benchmark read it directly) to change the
  bar: a number of GB (fractions allowed, up to 10240). Blank or unset is the 5 GB
  default. Only a plain `0` turns the check off; a word, a negative number, `-0`, a
  value that rounds to zero bytes or an absurdly large one is ignored (the default
  applies, with a warning in the log). The check looks only at the volume that holds
  `output/`. On a full disk every claimed job fails at once and is released, and
  nothing is charged. Clean up by hand, never on a schedule:
  ```bash
  dc --profile worker exec worker python -m modules.disk_guard --prune-days 30          # lists only
  dc --profile worker exec worker python -m modules.disk_guard --prune-days 30 --apply  # deletes
  ```
  By default it selects only **published** runs (the upload ledger says uploaded and
  the run's checkpoint was cleared, which is what the pipeline does after a
  successful upload), untouched for at least that many days (minimum 7). Held,
  blocked, awaiting-approval and upload-failed runs are never selected unless you
  add `--include-held`: their master can still be needed for approval, a re-upload
  or a paid download. A folder containing a file named `.keep`, a symlink, and any
  run that has not rendered yet are always skipped. Once a run is pruned its master
  can no longer be cut into a paid download, so keep the number generous.
- **Pinned SDKs.** `constraints.txt` pins `elevenlabs`, `google-genai`, `edge-tts`
  and `openai-whisper` to exact versions for the worker image, so a rebuild cannot
  change behaviour by itself. Raise a pin in its own change, after the tests pass.
- **Whisper model.** The image downloads the caption model at build time, so the
  first video no longer waits for it after the script and voice are paid.
- **First week.** Watch ElevenLabs characters, the Gemini billing page, each AI
  provider's dashboard, and `docker system df`.

## 8. Pausing the scheduled operator runs

`NIGHTSHIFT_PIPELINE_PAUSED` pauses the **scheduled operator runs** of
`daily_video.yml`. It is not a stop-everything button: read "What it does not stop"
below before relying on it.

**Pause.** Set the repository **Variable** `NIGHTSHIFT_PIPELINE_PAUSED` to `true`
(Settings > Secrets and variables > Actions > Variables). From the next hourly run,
`daily_video.yml` resolves to an empty matrix and the `make-video` job is skipped; the
run is green and the "Pick due channels" step logs
`pipeline paused by NIGHTSHIFT_PIPELINE_PAUSED`. Read that step in the next hourly run
to confirm.

**The value fails closed.** Only an empty value, `0`, `false`, `no` or `off` (any case,
spaces and one pair of quotes ignored) means "run". Anything else pauses: `1`, `true`,
`yes`, `on`, and also a typo such as `ture`. A value that is not one of the accepted words
logs `warning: NIGHTSHIFT_PIPELINE_PAUSED has an unrecognised value - treating as
PAUSED` and a GitHub `::warning::` annotation (the value is never printed). The reason:
whoever set it meant to stop something, and no video is the better failure.
It is a Variable, not a secret and not a database flag, so it also works when Supabase
is down.

**Resume.** Delete the variable or set it to `false`. The next hourly run schedules
channels again, each at its own `publish_hour_utc`. A slot that passed while paused is
made up only if you resume within the catch-up window (section 9) of that slot, and only
if the slot has no run recorded; set `NIGHTSHIFT_CATCHUP_HOURS=0` if you want a resume to
never start a past slot.

**Pause one channel.** Pausing a channel (or switching its schedule off) in the Command
Center still works, and now it also works for the operator's test channel Chronos (id
`default`). When every operator channel is paused the scheduler emits an empty matrix and
the log says `all operator channels paused`. Before this change that case re-added
`default` at the 15:00 UTC slot, so Chronos could not be paused.

**While Supabase is down, a channel pause is invisible.** The channel registry never
raises on a Supabase outage: it reads no rows, then synthesizes `default` as ACTIVE. The
scheduler now does a strict read of the `channels` table first and, if it fails, prints
`channel registry UNREADABLE (<type>) - FALLING BACK to the legacy default channel` plus a
`::warning::` annotation, then keeps the existing fail-open behaviour (it still schedules
`default`, so a database blip does not silently stop production). A channel pause stored
in the database cannot be read in that state; only `NIGHTSHIFT_PIPELINE_PAUSED` stops it.
Making that outage fail closed instead is an owner decision and is not made here.

**What it does not stop**

- A run already in progress. Cancel it in Actions.
- A manual dispatch that names a channel (`--only`). A dispatch with the channel left
  empty ("every active channel") does follow the pause and resolves to nothing.
- Command Center "Run now", storyboard approval, `/api/agent/run`, and customer-paid API
  or MCP `create_video` runs, which create `render_jobs`.
- `render_jobs` and the queue worker or VPS workers (`NIGHTSHIFT_RUN_BACKEND=queue`):
  they only run jobs somebody asked for, and nothing schedules them, so there is nothing
  to pause there.
- Spend from those paid or manual runs. A runaway there needs a different stop (a
  follow-up, not part of this switch).

Disabling the `Daily YouTube Video` workflow in the GitHub Actions UI is the
GitHub-native way to stop the schedule altogether (it also stops the hourly resolver).

## 9. A late or repeated schedule: catch-up, once per slot, topic memory

GitHub's cron is best effort: an hourly run can start late, or be dropped. Before this,
`daily_video.yml` ran only the channels whose `publish_hour_utc` equals the current UTC hour,
so a run delayed past the top of the hour skipped that channel's whole day, and nothing
noticed except the dead-man alert (`docs/operator-bot.md`). Everything below is reliability
only: it adds no publishing power, the schedule still passes `--privacy private`, and a run it
starts is the same run the exact hour would have started.

**Catch-up window.** A channel is due when its slot hour passed within the last
`NIGHTSHIFT_CATCHUP_HOURS` hours and its slot has no run recorded. Set it as a repository
**Variable** (like `NIGHTSHIFT_PIPELINE_PAUSED`): unset = 1, `0` (or `off`) = no catch-up,
1-6 = that many hours, above 6 = 6. A value that is not a whole number is the default (1)
with a `::warning::` that never echoes it. One hour is what a late or dropped cron needs (the next
hourly run is the catch-up); a wider window only buys more paid retries of a run that died without
writing a row (see "A failed run" below), so widen it deliberately. The log line is
`<channel> missed its <slot> UTC slot (<n>h ago) - catching up`.

**What counts as "a run was recorded".** The dead-man switch's own evidence, read from
Supabase through the same helpers (`modules/operator_bot/reliability.py`): a video row
(uploaded, held or blocked), a storyboard waiting for a person, or a run event, for that
channel since the slot began and before the next slot. One definition, so the alarm and the
catch-up cannot disagree. A slot that has any of it is not scheduled again, **at its exact
hour either** (for example after a manual run at 15:00:30). A named manual dispatch of the same
channel that finishes after the slot began counts as that slot's evidence too: a manual video at
15:20 means the 15:00 slot is not run again.

**Fail safe.** If that evidence cannot be read (Supabase down, a source cut at its row
limit, the channel not in the `channels` table) it is an unknown, and an unknown never starts
a paid run: the exact hour runs exactly as it always did, a catch-up does not happen, and a
`::warning::` names the channel. A registry that could not be read (the existing default-channel
fallback) also gets no catch-up. A channel that was created or edited after the slot began and
has produced nothing was never due for that slot (the dead-man's rule), so changing a channel's
hour or switching it on at 15:30 does not start the 14:00 slot.

**It can never run when paused.** The global switch `NIGHTSHIFT_PIPELINE_PAUSED` returns
before any of this; the candidates are only the channels the scheduler already allows
(ACTIVE, schedule on, verified, the operator's own), so a paused channel, a channel whose
schedule is off and a customer's channel are never caught up. The one thing to know: the
variable has no history, so if you pause and then resume inside the window, the slot that
passed during the pause is eligible. Set the window to 0 before resuming if you do not want that.

**One scheduled run per channel and slot.** The `make-video` job has a `concurrency` group for
scheduled runs only: `nightshift-slot-<channel>-<slot date>`, `cancel-in-progress: false`, so a late
cron and a catch-up queue instead of rendering twice at once and racing on the history cache. Nothing
running is ever cancelled. GitHub keeps one *pending* job per group, so a newer pending scheduled job
replaces an older one (it shows as cancelled); that is harmless, the next hour asks again. **Every
manual dispatch** (a named channel, a Command Center "Run now" that carries a credit hold, an
all-channels run) gets a group of its own (`nightshift-manual-<channel>-<run id>`), so it is never
queued behind or replaced by anything and behaves exactly as before this change; in particular a paid
run can never be cancelled before it claims its credit hold. The group is per channel, so it does not
change `max-parallel: 1` (which only limits how many of one run's channels render at once). A manual
run and a scheduled run of the same channel can therefore overlap in time; do not dispatch near the
cron hour unless you want that.

**The run asks again.** A scheduled job that waited in the group can start up to an hour after the
resolver chose it, so before it spends anything it re-checks (`tools/slot_guard.py`, first thing in
the "Run Chronos bot" step): is `NIGHTSHIFT_PIPELINE_PAUSED` on, is the channel still ACTIVE, schedule on,
verified and the operator's own, and does the slot still have no run. The run ahead of it has finished by
then and its video row exists, so the queued job stops with a green step and a log line saying why
(the step's `skipped` output is written but nothing reads it). This is the "already ran today" guard in
the run itself. A **manual dispatch that names a channel always runs** (it is an explicit instruction and
ignores the pause, as before). If the guard itself fails or cannot read, an exact-hour run goes ahead as
before and a catch-up does not. Known cost: a skipped job has already run checkout, `pip install` and the
token steps before the guard, and saves an (unchanged) history cache entry; the install order is not
changed here.

**A failed run does not count as "worked", and is retried.** The evidence is a video, held or blocked
row, a storyboard or a run event. A run that dies before it writes any of them (an OOM or timeout at
render, a provider outage) leaves no evidence, so the next hourly run inside the window runs the slot
again, up to the window (default 1, so one retry). That is a retry of paid work: the per-run and daily USD
caps (`CHRONOS_MAX_RUN_USD`, `CHRONOS_MAX_DAILY_USD`) only bite when the `CHRONOS_PRICE_*` prices are set,
and with none set the unpriced spend is not capped. The dead-man alert is the signal for a run that failed;
`NIGHTSHIFT_CATCHUP_HOURS=0` switches the retry off. Follow-up idea, not in this change: have the run write a
direct "slot claimed" row when it starts, so a started-and-failed run is distinguishable from a never-started one.

**Topic memory survives a lost cache.** `history/topics.json` is only an Actions cache (evicted
after 7 days). When a channel has no topics of its own locally, the run now rebuilds them from
that channel's `videos` rows (uploaded, held and blocked; the last 200 topics of the last 365 days,
the same window the dedup uses) before it picks a topic, in the file's existing format. It only
reads; if Supabase cannot be read the run goes on with whatever local history exists and logs a
warning. Titles are never logged, only counts. The semantic duplicate store
(`topic_vectors*.npz`) is refilled from them too when it is empty.
