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
| `YOUTUBE_TOKEN_JSON` | the whole `youtube_token.json` (optional once the default channel is connected with the **Connect YouTube** button on the Channels page: that connection, kept in Vault, wins; see docs/MULTI_CHANNEL.md) |
| `YOUTUBE_CHANNEL_ID` | |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | the Command Center's OAuth client: needed to refresh any token connected from the Command Center (customers' channels, and your own channels when you press **Connect YouTube**) |

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
| `veo` | `VEO_API_KEY` and **`VEO_MODEL`** (repository variable, REQUIRED: there is no default) | a Gemini key on a paid tier with Veo access. The former default, `veo-3.1-generate-preview`, is past the earliest shutdown date Google lists (2026-10-22); the run stops before it spends, with the reason, when `VEO_MODEL` is empty or names such an id |
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
there. Run the doctor in the container, as above, after a deploy. It proves the
default channel's token and every other scheduled operator channel's
(`CHRONOS_YT_TOKEN_<REF>`, one free in-memory refresh each, listed as `token/<channel id>`);
a run that will upload also asks Google about its own channel's token before it spends
anything, and stops there when the token is expired or revoked.

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
(Settings > Secrets and variables > Actions > Variables). From the next scheduled tick,
`daily_video.yml` resolves to an empty matrix and the `make-video` job is skipped; the
run is green and the "Pick due channels" step logs
`pipeline paused by NIGHTSHIFT_PIPELINE_PAUSED`. Read that step in the next scheduled run
to confirm.

**The value fails closed.** Only an empty value, `0`, `false`, `no` or `off` (any case,
spaces and one pair of quotes ignored) means "run". Anything else pauses: `1`, `true`,
`yes`, `on`, and also a typo such as `ture`. A value that is not one of the accepted words
logs `warning: NIGHTSHIFT_PIPELINE_PAUSED has an unrecognised value - treating as
PAUSED` and a GitHub `::warning::` annotation (the value is never printed). The reason:
whoever set it meant to stop something, and no video is the better failure.
It is a Variable, not a secret and not a database flag, so it also works when Supabase
is down.

**Resume.** Delete the variable or set it to `false`. The next scheduled tick schedules
channels again, each at its own `publish_hour_utc`. A slot that passed while paused is
made up only if you resume within the catch-up window (section 9) of that slot, and only
if the slot has no run recorded; set `NIGHTSHIFT_CATCHUP_HOURS=0` if you want a resume to
never start a past slot.

**The operator bot knows about the pause.** The same variable is passed to the operator
bot (`operator_alerts.yml`, `telegram_control.yml`, and the always-on service through
`deploy_web.yml`), which reads it with the scheduler's own function, so the two cannot
disagree. While it is on: the dead-man switch raises **no** "No video from channel ..."
alert for the paused slots, the daily digest and `/today` say `paused` where they would say
`MISSING`, and the bot sends **one information alert a day** (Telegram only, never e-mail)
"Scheduled runs are paused by NIGHTSHIFT_PIPELINE_PAUSED", so a pause left on for weeks
is not forgotten; lifting it is followed by one "no longer paused" note. The scheduled
readiness check (`doctor_scheduled.yml`) shows a `[WARN] pipeline/scheduled runs` line in
its job summary and never records the pause as a failure. Run by hand (a laptop, the worker
container) the same check reads UNVERIFIED when the variable is not set in that environment,
because only the scheduled doctor is given the repository variable; it reports WARN wherever
it does see a pause. The always-on bot service reads
the variable **at deploy time** (a snapshot taken by Deploy web), while the scheduler and
the doctor read the live repository variable, so for as long as you have not run Deploy
web the bot can be wrong in BOTH directions: **pause set but not deployed** means the bot
still thinks the pipeline runs, so it can raise a false "No video from channel ..."
alert for a slot you stopped on purpose (a warn alert, so it can also be e-mailed);
**pause lifted but not deployed** means the bot still thinks it is paused, so a real
dead-man alert is silenced and the daily "paused" note contradicts the doctor. After
changing the variable run Actions > *Deploy web*; the daily "paused" alert says so too.
(The Actions-based passes, `operator_alerts.yml` and `telegram_control.yml`, read it on
every run and have no stale window.) The bot also keeps no history of the pause: after you
resume, an overdue slot that made no video can raise **two** false dead-man alerts per
channel on the first pass, yesterday's and, if you resume after today's deadline
(`publish_hour_utc` + grace), today's; both are warn alerts, so they can be e-mailed too.
Mute 24h (kind `pipeline`) if you do not want them. A follow-up (not in this change): have
the pipeline's own run write a record so the bot can tell a paused slot from a missed one.

**Misconfiguration warnings.** In GitHub Actions the resolver now prints
`::warning::Supabase is not configured - channel pauses cannot be read` when the Supabase
secrets are not set (every pause stored in the Command Center is then invisible to it), and a
warning when the `channels` table is empty (migration 0001 seeds `default`, so an empty table
almost always means the secrets point at the wrong project). Scheduling is unchanged: it still
falls back to the default channel.

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

**What GitHub guarantees: nothing.** Scheduled workflows are best effort. A tick can start late or be dropped,
and this repository's own history shows how often: 268 scheduled runs of the old hourly cron over seven weeks is
about one tick in four delivered (one every 4.4 hours on average), at random minutes, with gaps of up to a day.
Counting, for every hour of those weeks, whether any delivered tick fell in the hour's catch-up window, a slot was
reached 22% of the time at its exact hour, 45% with a one-hour window, 79% with three hours and 96% with six. A
slot with no tick in its window is a lost video (2026-10-21: runs at 17:45 and 21:00, then 00:18, 2h18 after the 22:00
slot, outside the one-hour window; the dead-man alert fired and was delivered, so the monitoring worked). Everything
below is reliability only: it adds no publishing power, the schedule still passes `--privacy private`, and a run it
starts is the same run the exact hour would have started.

**Four ticks an hour.** `daily_video.yml` has two cron entries, `0 * * * *` (the original) and `15,30,45 * * * *`.
Each tick resolves the channels due at the UTC hour it actually runs in, exactly as the single hourly tick did. More
ticks mean more chances for a tick to land in a slot's window; they do not mean more runs (see "At most one run per
slot" below). A tick with nothing due costs one ~15 second `resolve` job on a public repository. Whether GitHub
delivers the extra entries at the same rate as the original one is not something this repository can know in
advance; the rate is visible afterwards in the Actions list (the scheduled runs per day).

**Catch-up window.** A channel is due when its slot hour passed within the last
`NIGHTSHIFT_CATCHUP_HOURS` hours and its slot has no run recorded. Set it as a repository
**Variable** (like `NIGHTSHIFT_PIPELINE_PAUSED`): **unset = 3**, `0` (or `off`) = no catch-up,
1-6 = that many hours, above 6 = 6. A value that is not a whole number is the default (3)
with a `::warning::` that never echoes it. Three hours means a slot is made up by any tick that lands
from its hour until the end of the third hour after it (22:00 slot: ticks until 01:59). The downside of a
wide window is a video that goes up at an odd hour (private first, so acceptable) and, for a run that died
without writing a row, more retries (see "A failed run" below); lower it with the variable if that matters
more to you than the lost day. The log line is `<channel> missed its <slot> UTC slot (<n>h ago) - catching up`.

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
a paid run: the exact hour of the **original** `0 * * * *` tick runs exactly as it always did, a
catch-up does not happen, a **backup** tick (`15,30,45`) hands out nothing, and a
`::warning::` names the channel. The original tick keeps its old fail-open behaviour (the owner's
documented choice: an outage must not cost the day's video by itself), so an outage cannot turn four
ticks an hour into four runs. The workflow tells the resolver which cron entry fired
(`github.event.schedule`, `--tick`); anything other than exactly `0 * * * *` counts as a backup, and
a backup's row is marked `catchup: true`, which makes the guard in the run strict too. A backup tick at the exact hour also honours the dead-man's "never due" rule (as a catch-up does): a channel created or edited after its slot began, with nothing produced, gets no unplanned run from a backup tick. The first cron
entry must therefore stay `0 * * * *` (`modules/schedule_catchup.PRIMARY_CRON`; a test pins it). A registry that could not be read (the existing default-channel
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

**At most one run per channel and slot, however many ticks.** Three independent checks, each of which stops
a second run on its own, and a test (`tests/test_cron_robustness_sim.py`) drives the real resolver and the real
guard through simulated days of dropped and delayed ticks to prove it:

1. *The resolver* hands out a slot only if the evidence shows no run for it.
2. *The concurrency group* `nightshift-slot-<channel>-<slot date>` lets one job of a slot run at a time and queues
   the rest (one pending job; a newer one replaces an older one). Two ticks that start in the same minute, or a tick
   that arrives while the first run is still rendering, therefore queue behind it.
3. *The guard in the run* (`tools/slot_guard.py`) asks again once the job holds the group, which is after the run
   ahead of it has finished and written its video row, and stops with exit 3 and nothing spent.

**Exposure.** A scheduled run carries no credit hold, so it spends the operator's money. The maximum for a slot
is **the attempt cap**: at most `NIGHTSHIFT_SLOT_MAX_ATTEMPTS` (default 2, hard maximum 4) starts of the pipeline
per operator channel and slot, and exactly one when the first one writes a video, held or blocked row (then nothing
else starts). However many ticks GitHub delivers and whatever dies, a slot cannot buy more than that many runs,
**with one exception that is the owner's existing fail-open choice: under a Supabase outage at the slot's exact
hour the original `0 * * * *` tick still starts the run and cannot record its attempt, so the true bound there is
cap + 1 (and one more if a delayed original tick of the previous hour lands in the same clock hour).** Backups and
catch-ups never start on an outage. The per-run and daily USD caps (`CHRONOS_MAX_RUN_USD`, `CHRONOS_MAX_DAILY_USD`)
still apply on top, but only when the `CHRONOS_PRICE_*` prices are set; unpriced spend is not capped by them, which
is why the attempt cap exists. What the wider window changes is *when*: a missed slot is made up for up to three
hours instead of one, so a day's video can appear at an odd hour (private until you publish it).

**Attempt cap (`NIGHTSHIFT_SLOT_MAX_ATTEMPTS`).** An *attempt* is a scheduled run that got past the checks before
anything is spent (the pipeline pause, the channel still scheduled, the slot still without a video) and reached the
point of starting the pipeline: `tools/slot_guard.py` records it, in the run, just before `main.py`. The record is a
row in `system_events` named `schedule.attempt` with the key `slot-attempt:<channel>:<slot start>:<n>`, inserted
with PostgREST's ignore-duplicates, so exactly one job can ever hold attempt number `n` and two jobs racing cannot
both start. Its only fields are the channel, the time, and the slot start, the number and the cap. It is written
straight to Supabase (the run's own event log reaches Supabase once a day, too late) and it is not slot evidence:
a video row is, an attempt is not, so a run that died stays retryable up to the cap.
- **Enforced twice.** The resolver does not hand out a slot that has used its attempts (any tick, any hour of the
  window), and the guard in the run claims the next number only if one is left; a refused claim stops the run before
  anything is spent and says `used its N attempt(s)`.
- **What counts.** Every run that reaches the claim counts, including one that then stopped for its own reasons
  inside `main.py` (a credential preflight, exit 79 held before render, exit 78 spend ceiling). The distinction
  "provably spent nothing" is not available at the claim, so it fails closed: it counts, and the log says so. A
  job that fails earlier (token restore, install steps) never reaches the claim and uses no attempt.
- **Unreadable.** If the attempt count or the claim cannot be read or written, a catch-up or a backup tick starts
  nothing (as for unreadable evidence). The original hourly tick's exact-hour run keeps its documented fail-open
  behaviour, and a denied claim stops it too. That is the one way a slot can exceed the cap: the original tick
  running at its exact hour while Supabase is unreadable, which is the existing owner choice.
- **Minimum gap between attempts (`NIGHTSHIFT_SLOT_MIN_ATTEMPT_GAP_MINUTES`, default 60, 10-180).** A run that
  fails within minutes (a dead token, a provider outage) would otherwise burn every attempt within a tick or two
  (ticks are 15 minutes apart) and the slot would be dead before anyone could fix the cause. A slot whose latest
  attempt is less than the gap old is not handed out by the resolver, and the guard exits 3 WITHOUT claiming, so the
  attempt stays for a later tick. The gap is measured from the previous claim's time (`system_events.ts`, which
  mixes naive and `Z` UTC strings; both are read; an unreadable one counts as just claimed). In the simulation the
  second attempt comes 63-87 minutes after the first, so a credential fixed within an hour of the first attempt is
  always picked up inside the default 3 h window; for a slower fix raise the gap or the cap, or run it by hand.
  With the default cap of 2 the two attempts fit the window; a cap above 2 needs a longer window (4 attempts at
  60+ minutes apart do not fit in 3 hours).
- **Manual dispatches are exempt** (an explicit instruction, and they never ask the guard); they neither count nor
  are stopped. Beware that a manual run does not reset a used-up slot either, and a video it makes does end the slot.
- **Dead-man alert.** When the last attempt recorded for a slot was its cap, the alert (its own key,
  `deadman-capped:<channel>:<day>`, so an earlier plain alert cannot swallow it) says `the scheduler stopped after N
  attempt(s) at it (its cap)` and gives the manual step.

**A failed run does not count as "worked", and is retried up to the cap.** The evidence is a video, held or blocked
row, a storyboard or a run event. A run that dies before it writes any of them (an OOM or timeout at render, a
provider outage) leaves no evidence, so the next tick inside the window starts the slot again, until the attempt cap
is used up. **The second attempt is a fresh run, not a resume.** The scheduled run does not pass `--resume`, so it
picks a topic again, rewrites the script and pays for the voice, stills and clips again; the saved run state of the
first attempt (checkpoint, paid-task ledger, upload-attempt ledger, script, kept in the Actions cache for seven days
by `tools/run_state_cache.py`) is restored into `output/` but a fresh run does not read it (its ledgers belong to the first run's epoch). That is exactly why the number of attempts is capped. If a slot died after paying and you would
rather continue than start over, run it by hand with `resume` ticked and the channel named: that reuses the saved
script and polls the paid provider tasks instead of buying them again. `NIGHTSHIFT_CATCHUP_HOURS=0` switches the
catch-up retry off, and `NIGHTSHIFT_SLOT_MAX_ATTEMPTS=1` makes every slot a single try.

**When the window has passed: run it by hand.** The dead-man alert (default 3 h after the slot; a tick in the
window's last hour can still make the slot up after it, and a "recovered" note follows) now ends with the
step: GitHub Actions, workflow **Daily YouTube Video**, **Run workflow**, `channel` = the channel id (everything
else empty; `privacy` is `private` by default). A manual run of a named channel always runs: it ignores the pause and
the once-per-slot guard, so check the slot has no video first, or you will pay for a second one. The same can be done
with the Command Center "Run now".

**Topic memory survives a lost cache.** `history/topics.json` is only an Actions cache (evicted
after 7 days). When a channel has no topics of its own locally, the run now rebuilds them from
that channel's `videos` rows (uploaded, held and blocked; the last 200 topics of the last 365 days,
the same window the dedup uses) before it picks a topic, in the file's existing format. It only
reads; if Supabase cannot be read the run goes on with whatever local history exists and logs a
warning. Titles are never logged, only counts. The semantic duplicate store
(`topic_vectors*.npz`) is refilled from them too when it is empty.
