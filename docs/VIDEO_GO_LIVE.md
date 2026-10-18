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

- Migrations applied through the latest one in `supabase/migrations/` (the doctor
  names any it cannot find; see `docs/MIGRATIONS.md`).
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
`PASS`.

On the server (the `dc` shortcut is defined in `docs/DEPLOY_AX42.md`; spelled out it
is `docker compose --env-file /opt/nightshift/.env.web -f /opt/nightshift/app/deploy/docker-compose.yml`):

```bash
cd /opt/nightshift/app
dc --profile worker exec worker python tools/doctor.py            # human report
dc --profile worker exec worker python tools/doctor.py --json     # machine-readable
dc --profile worker exec worker python tools/doctor.py --offline  # configuration and host only, no network
# the same thing without compose, using the container name:
docker exec nightshift-worker-1 python tools/doctor.py
```

It must run inside the worker container: that is the only place that sees the
environment the worker really has. It exists in the image once the change that adds
`tools/doctor.py` has been deployed.

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
- Exit code: `0` ready, `1` something blocking, `2` warnings only (or nothing could
  be checked).
- `--extended` adds Gemini's free model lookup (it is not otherwise used by the
  app). `--no-youtube` skips the YouTube token refresh, which is a free request whose
  result is held in memory and not saved.
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

- **Disk.** A run refuses to start under 5 GB free (the helper
  `modules/disk_guard.py`; the doctor reports the same number). Old finished or held
  runs can be cleaned by hand, never on a schedule:
  ```bash
  dc --profile worker exec worker python -m modules.disk_guard --prune-days 30          # lists only
  dc --profile worker exec worker python -m modules.disk_guard --prune-days 30 --apply  # deletes
  ```
  It only touches run folders that finished or were rendered and held, untouched for
  at least that many days (minimum 7), skips any folder containing a file named
  `.keep`, and never an unfinished run. A held video's master can be needed for a
  paid download or an approval, so keep the number generous.
- **Pinned SDKs.** `constraints.txt` pins `elevenlabs`, `google-genai`, `edge-tts`
  and `openai-whisper` to exact versions for the worker image, so a rebuild cannot
  change behaviour by itself. Raise a pin in its own change, after the tests pass.
- **Whisper model.** The image downloads the caption model at build time, so the
  first video no longer waits for it after the script and voice are paid.
- **First week.** Watch ElevenLabs characters, the Gemini billing page, each AI
  provider's dashboard, and `docker system df`.
