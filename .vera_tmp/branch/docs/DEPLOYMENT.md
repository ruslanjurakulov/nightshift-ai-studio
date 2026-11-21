# Deployment & Go-Live Checklist

> **Historical (corrected 2026-11-12).** This checklist was written before the first live run and
> describes the original GitHub Actions setup of the pipeline. Two of its claims are no longer true:
> the pipeline has run on GitHub Actions since, and the YouTube upload is **not** unconditional. The
> publish gate (`modules/publish_gate.py`) runs before every upload and can only block it, uploads are
> private by default, and per-channel auto publish and approval rules sit on top of the gate. The
> `HUMAN_APPROVAL` stage in `modules/pipeline_stages.py` and `tools/approve_run.py` are an audit trail
> only. The current map is [ARCHITECTURE.md](ARCHITECTURE.md); the web app's deploy is
> [DEPLOY_AX42.md](DEPLOY_AX42.md).

---

## 1. Prerequisites — accounts & API keys to obtain

| # | Thing you need | Where to get it | Used for |
|---|----------------|-----------------|----------|
| 1 | **Google AI Studio — Gemini API key** | https://aistudio.google.com/apikey | Script generation, research, fact-check, comment classification (`GEMINI_MODEL = gemini-3.6-flash` in `config.py`) |
| 2 | **Pexels API key** | https://www.pexels.com/api/ | Stock HD video/image footage (`modules/media_fetcher.py`) |
| 3 | **Google Cloud project** with **YouTube Data API v3** enabled, plus an **OAuth 2.0 Client ID (Desktop app)** | https://console.cloud.google.com → APIs & Services → Enable "YouTube Data API v3" → Credentials → Create OAuth client ID (Desktop). For the intelligence layer also enable **YouTube Analytics API**. | Uploading videos, reading analytics, fetching comments (OAuth) |
| 4 | **YouTube Data API key** (a plain API key credential, *not* OAuth) | Same Google Cloud project → Credentials → Create credentials → API key | Public-data reads: competitor + trend polling (`modules/competitor_monitor.py`, `modules/trend_detector.py`) |
| 5 | **The target YouTube channel** (its channel ID) | Run `python main.py --list-channels` after OAuth (Section 4) | Confirms uploads target the right channel |
| 6 | *(optional)* **ElevenLabs API key** | https://elevenlabs.io | Premium TTS — only if you switch `TTS_PROVIDER` from `edge` to `elevenlabs` |
| 7 | *(optional)* **Slack incoming webhook** | https://api.slack.com/messaging/webhooks | "Runs pending approval" nudge (`tools/check_pending_approvals.py`) |

The OAuth **Client ID** (item 3) is downloaded as a JSON file — this becomes your
local `client_secret.json`. The OAuth **token** (`youtube_token.json`) is *not*
downloaded; you mint it once locally in Section 4.

---

## 2. GitHub Actions secrets & variables

Set these under **repo → Settings → Secrets and variables → Actions**. Secrets go
on the **Secrets** tab; `COMPETITOR_CHANNEL_IDS` is a **Variable** (Variables tab),
because the workflow reads it as `${{ vars.* }}`, not `${{ secrets.* }}`.

Every name below is referenced verbatim by a workflow file — nothing here is
invented.

### Secrets

| Secret name | Used by workflow(s) | Required? | How to get it |
|-------------|---------------------|-----------|---------------|
| `GEMINI_API_KEY` | `daily_video.yml`, `intelligence_poll.yml` | **Required** | Google AI Studio key (Prereq 1) |
| `PEXELS_API_KEY` | `daily_video.yml` | **Required** | Pexels key (Prereq 2) |
| `YOUTUBE_CLIENT_SECRET_JSON` | `daily_video.yml`, `intelligence_poll.yml` | **Required** | Full contents of `client_secret.json` (OAuth Desktop client, Prereq 3). Both workflows write it back to disk unconditionally. |
| `YOUTUBE_TOKEN_JSON` | `daily_video.yml`, `intelligence_poll.yml` | **Required to publish** (workflows guard on it: without it the upload/analytics/comment steps fail, since headless CI cannot run the OAuth browser consent) | Full contents of the `youtube_token.json` you mint locally in Section 4 |
| `YOUTUBE_CHANNEL_ID` | `daily_video.yml`, `intelligence_poll.yml` | Recommended (code defaults to empty → uploads to the account's default channel; when set, the uploader verifies it belongs to your account — `modules/youtube_uploader.py._verify_channel`) | `python main.py --list-channels` (Prereq 5) |
| `YOUTUBE_DATA_API_KEY` | `intelligence_poll.yml` | Optional — intelligence layer degrades gracefully without it (competitor/trend passes read empty and skip) | Google Cloud API key (Prereq 4) |
| `ELEVENLABS_API_KEY` | `daily_video.yml` | Optional — the daily workflow hardcodes `TTS_PROVIDER=edge`, so this is unused unless you change that | ElevenLabs (Prereq 6) |
| `SLACK_WEBHOOK_URL` | `check_pending_approvals.yml` | Optional — the notifier always logs; Slack is only attempted when set (`modules/notifier.py`) | Slack incoming webhook (Prereq 7) |

### Variables

| Variable name | Used by workflow | Required? | How to get it |
|---------------|------------------|-----------|---------------|
| `COMPETITOR_CHANNEL_IDS` | `intelligence_poll.yml` (`${{ vars.COMPETITOR_CHANNEL_IDS }}`) | Optional | Comma-separated channel IDs, e.g. `UCxxxx,UCyyyy`. Empty → no competitors polled. |

> **Note on `ELEVENLABS_API_KEY`:** because `daily_video.yml` sets
> `TTS_PROVIDER: edge` inline, Edge TTS (free) is used and no ElevenLabs key is
> needed for the default configuration. Set the secret only if you also change
> `TTS_PROVIDER` to `elevenlabs`.

---

## 3. One-time OAuth consent — minting `youtube_token.json`

The uploader (`modules/youtube_uploader.py`), the comment fetcher
(`modules/comment_fetcher.py`), and the analytics client
(`modules/analytics_client.py`) all authenticate the same way: they read the
OAuth token file at `YOUTUBE_TOKEN_FILE`; if it is missing/invalid and no refresh
is possible, they fall back to `InstalledAppFlow.from_client_secrets_file(...)`
and `flow.run_local_server(port=0)` — i.e. **a browser consent screen**. That
browser step **cannot run in GitHub Actions**, so you must generate the token
**once, locally**, and store it as a secret.

**Steps (run on your own machine, one time):**

1. Put the OAuth client JSON from Google Cloud (Prereq 3) at the repo root as
   `client_secret.json` (or point `YOUTUBE_CLIENT_SECRET_FILE` at it in `.env`).
2. Populate a local `.env` from `.env.example` (at minimum `GEMINI_API_KEY`,
   `PEXELS_API_KEY`; set `YOUTUBE_CHANNEL_ID` once you know it).
3. Run a command that triggers auth. The simplest is listing channels:
   ```bash
   python main.py --list-channels
   ```
   A browser window opens → sign in with the Google account that owns the target
   channel → grant the requested scopes (upload, readonly, yt-analytics readonly —
   see `YOUTUBE_SCOPES` in `config.py`). On success the token is written to disk.
4. Copy the printed channel ID into `.env` as `YOUTUBE_CHANNEL_ID` (and into the
   `YOUTUBE_CHANNEL_ID` GitHub secret).

**Where the token lands (important filename gotcha):**
`config.py` builds the token path as
`youtube_token{_channel_suffix}.json`, where the suffix is `_<YOUTUBE_CHANNEL_ID>`
**when `YOUTUBE_CHANNEL_ID` is set**, and empty otherwise. So:

- If you ran the consent step **with `YOUTUBE_CHANNEL_ID` set**, the file is
  `youtube_token_<channelid>.json`.
- If you ran it **without** it set, the file is `youtube_token.json`.

The workflows write the `YOUTUBE_TOKEN_JSON` secret back to **`youtube_token.json`
(unsuffixed)**, while also setting `YOUTUBE_CHANNEL_ID` — so `config.py` asks for
`youtube_token_<channelid>.json`, a name nothing wrote.

**This is handled.** `modules.channel_credentials.token_path()` falls back to the
unsuffixed `youtube_token.json` when the suffixed file does not exist, which is
what every consumer resolves through (uploader, analytics client, comment
fetcher). So it does not matter which of the two names your local token ended up
under: store the JSON body of whichever `youtube_token*.json` was produced, and
CI will find it.

The fallback can only ever *find* a token, never shadow one — it is consulted
only when the configured, suffixed file is absent. Before the fallback existed,
this mismatch made every CI run die in
`require_interactive_consent_possible()` ("no browser on a CI runner"), which
reads exactly like a missing secret and is not one.

**Store the two files as secrets (raw JSON, not base64):**
The workflows restore them with a plain `echo '...' > file` (no `base64 -d`), so
paste the **raw file contents**:

- `YOUTUBE_CLIENT_SECRET_JSON` ← entire contents of `client_secret.json`
- `YOUTUBE_TOKEN_JSON`         ← entire contents of your `youtube_token*.json`

`tools/setup_check.py --reveal` prints exactly these values ready to paste
(terminal-only) under a "GitHub Secrets" heading — a convenient way to copy them.

---

## 4. Optional / intelligence-layer configuration

The intelligence poll (`tools/run_intelligence_poll.py`, run by
`intelligence_poll.yml`) is built to **degrade gracefully** — each pass is
independently defensive, so a missing key or empty list skips that pass rather
than failing the run.

| Config | What it unlocks | Behavior when absent |
|--------|-----------------|----------------------|
| `YOUTUBE_DATA_API_KEY` | Competitor monitoring + trending-video detection (public-data reads) | Those passes read with an empty key and skip; comment/analytics passes (OAuth) unaffected |
| `COMPETITOR_CHANNEL_IDS` (Actions **variable**) | Polls the named channels for competitive signal | Empty string → zero competitors polled (`_competitor_channel_ids()` returns `[]`) |
| `SLACK_WEBHOOK_URL` | Slack "runs pending approval" nudge from `check_pending_approvals.yml` | Notifier still logs to stdout/log; Slack simply not attempted |
| `ELEVENLABS_API_KEY` / `TTS_PROVIDER=elevenlabs` | Premium ElevenLabs narration | Defaults to free Edge TTS |

The whole intelligence layer is optional for *publishing*: the daily video job
does not depend on it. It exists to feed the content-planning queue that
`TopicManager` consumes before spending a Gemini call.

---

## 5. Dry-run & verification (test without publishing)

Do these in order before letting the daily job publish.

1. **Local preflight** — tells you exactly what's still missing:
   ```bash
   python tools/setup_check.py
   ```
   Fix every `FAIL` row (requires `ffmpeg`, `imagemagick`, fonts, and the Python
   deps from `requirements.txt`). Exit code 0 = local runs possible.

2. **Local full pipeline, no upload** — proves generation works end to end and
   writes a real `.mp4` to `output/<slug>/` without touching YouTube:
   ```bash
   python main.py --niche "history mysteries" --no-upload
   ```
   (`--no-upload` sets `skip_upload=True`, so Stage 8 is skipped entirely.)

3. **Verify Actions secrets with a non-publishing workflow first.** In GitHub →
   Actions, `workflow_dispatch`-trigger **Intelligence Poll** (`intelligence_poll.yml`).
   It **never uploads** — it only reads analytics/competitors/trends and comments —
   so it's a safe way to confirm `GEMINI_API_KEY`, `YOUTUBE_CLIENT_SECRET_JSON`,
   `YOUTUBE_TOKEN_JSON`, `YOUTUBE_CHANNEL_ID`, and `YOUTUBE_DATA_API_KEY` are all
   valid in the CI environment. Check the run log for auth warnings (e.g.
   "CommentFetcher auth failed", "IntelligencePoller failed") — those indicate a
   bad or missing token before any publish is at stake.

4. **Optional: dispatch the daily job privately.** You can `workflow_dispatch`
   **Daily YouTube Video** with `privacy: private` to do a real but unlisted-to-you
   upload as a final smoke test, then delete the test video. Remember: any dispatch
   of this workflow *does* upload.

---

## 6. Go-live

1. Confirm all **Required** secrets from Section 2 are set, and the token/secret
   filename caveat from Section 3 is resolved (Intelligence Poll ran clean in
   Section 5, step 3).
2. Ensure the **Daily YouTube Video** workflow is enabled (Actions tab — GitHub
   auto-disables schedules on repos with no recent activity; a manual dispatch or
   an enable click reactivates it). Its cron is `0 15 * * *` (15:00 UTC daily,
   defined in `daily_video.yml`).
3. Understand the trigger: **the first real, automatic upload happens on the next
   15:00 UTC cron tick.** With the publish gate intentionally not enforced, that
   run *will* publish. Keep `YOUTUBE_PRIVACY=private` (the default, and the
   workflow's default dispatch input) until you've reviewed several outputs, then
   switch to `unlisted`/`public` deliberately via the dispatch input or by
   changing the default.
4. The other schedules come along for free once secrets are set: Intelligence Poll
   at `0 20 * * *`, and Check Pending Approvals every 6 hours (`0 */6 * * *`).

---

## 7. Open items — critical path (P0 / P1)

All operator/credential tasks. **No code changes are required to go live.**

**P0 — blocking any real run:**
- [ ] Set `GEMINI_API_KEY` (secret) — Prereq 1.
- [ ] Set `PEXELS_API_KEY` (secret) — Prereq 2.
- [ ] Create Google Cloud project, enable YouTube Data API v3 (+ Analytics API),
      create OAuth Desktop client → store contents as `YOUTUBE_CLIENT_SECRET_JSON`.
- [ ] Run local OAuth consent once → mint `youtube_token.json` → store contents as
      `YOUTUBE_TOKEN_JSON` (Section 3).
- [ ] Resolve the token **filename suffix** caveat (Section 3) so CI actually
      finds the token when `YOUTUBE_CHANNEL_ID` is set.

**P1 — needed for correct/complete operation:**
- [ ] Set `YOUTUBE_CHANNEL_ID` (secret) so uploads are verified against the
      intended channel rather than the account default.
- [ ] Run `python tools/setup_check.py` locally and clear all `FAIL` rows.
- [ ] Dry-run `main.py --no-upload` locally (Section 5, step 2).
- [ ] `workflow_dispatch` **Intelligence Poll** and confirm no auth warnings
      (Section 5, step 3) before enabling the daily publish.
- [ ] Set `YOUTUBE_DATA_API_KEY` (secret) to enable competitor/trend polling.
- [ ] Decide and set final `YOUTUBE_PRIVACY` posture; confirm the Daily schedule
      is enabled (Section 6).

**P2 — optional enhancements:**
- [ ] Set `COMPETITOR_CHANNEL_IDS` (Actions **variable**) to feed competitor signal.
- [ ] Set `SLACK_WEBHOOK_URL` (secret) for approval-pending nudges.
- [ ] Set `ELEVENLABS_API_KEY` + `TTS_PROVIDER=elevenlabs` only if you want
      premium narration instead of free Edge TTS.

---

*This checklist is derived directly from `config.py`, the three workflow files in
`.github/workflows/`, and the modules/tools they invoke. It contains no secret
values — only names and how to obtain them.*
