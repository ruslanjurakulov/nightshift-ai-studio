# Nightshift → Creative OS: audit and implementation plan

Status: **plan only**. This document ships no feature code. It is Step 1 of
the Creative OS work: what exists today (from the source, not the README),
which providers really have an official API, the target architecture built out
of the pieces we already have, the data model, and a PR-by-PR roadmap.

Target, in the owner's words: an orchestrator → task planner + model router →
capability layer (image / video / audio) → provider adapters → durable jobs →
media library → creative workspace / timeline → render → export / publish /
analytics. **One core** shared by the web app, the REST API and MCP.

Migration numbering: 0031 is the public API (PR #250, open), 0032 is taken by
the small `render_jobs` insert-policy fix. **New migrations here start at 0033.**

---

## 0. Ground rules this plan keeps (from `CLAUDE.md`)

These decide the architecture more than any feature request does:

| Rule | Consequence for Creative OS |
| :-- | :-- |
| #3 Nothing in a browser publishes, re-renders or spends; the Command Center holds the **anon key only** | Every paid action is a **security-definer SQL function** called under the user's session (or an API key hash, like 0031). The Next server never holds the service key and never holds provider keys. |
| #4 No silent quality fallback | A user-selected model is never swapped. Router failover exists only in modes the user chose (AUTO/CHEAP/FAST), and every substitution is recorded and shown. |
| #5 Unknown is not a number | Provider cost is `null` until a price is configured; a model is "available" only after a recorded live probe. |
| #6 Fail early, name the remedy | Quote + hold before submit; errors carry a remedy code (`insufficient_credits`, `provider_key_missing`, `model_unavailable`). |
| Additive migrations, app degrades honestly | Every new page says "not enabled on this deployment" when its migration is missing (same as 0017 / 0030 pages today). |

---

## 1. Current-state map

Legend: **EXISTS** = reuse as is · **PARTIAL** = extend · **MISSING** = build.

### 1.1 Runtime and infrastructure

| Component | Files | Status | Notes |
| :-- | :-- | :-- | :-- |
| Pipeline (one run = one channel video) | `main.py` (1378 lines), `modules/pipeline_stages.py`, `modules/run_checkpoint.py` | EXISTS | Stays the "autonomous YouTube" product; Creative OS runs beside it, not inside it. |
| Queue worker | `tools/queue_worker.py`, `Dockerfile.worker`, `modules/run_request.py` | PARTIAL | Claims `render_jobs` **one at a time**; publish requests (0029) and downloads (0030) are serviced *between* render jobs. A 20 s image job would wait behind a 30 min render → Creative jobs need their **own lane** (separate process / compose service, same image). Reuse: heartbeat, stale re-queue, secret scrubber (`scrub`, `secret_values`), SIGTERM grace. |
| Deploy (Hetzner AX42: 8 cores, 64 GB, 2×512 GB NVMe RAID1) | `deploy/docker-compose.yml` (web, caddy, worker), `deploy/build-worker-env.py`, `docs/DEPLOY_AX42.md` | EXISTS | Volumes `worker_output`, `worker_downloads` (web mounts downloads **read-only**). Web container is `read_only: true`. |
| GitHub Actions bot | `.github/workflows/daily_video.yml` (+ tests.yml, frontend.yml, video-engine.yml …) | EXISTS | 2 cores, 7.9 GB; not a place for interactive creative jobs. |
| Command Center (Next.js App Router) | `command-center/app/(app)/[channel]/*`, `command-center/lib/*`, `middleware.ts` | EXISTS | URLs are channel-scoped (`/{channel}/{section}`); Creative OS is **org**-scoped → needs an org-level route group (see §3.7). |
| Edge Functions | `supabase/functions/paddle-webhook`, `_shared/paddle.ts` | EXISTS | Payments only. No need for new Edge Functions in P0. |
| Realtime | `command-center/lib/useRealtimeEvents.ts` | EXISTS | Reuse for live job status in the workspace. |

### 1.2 Tenancy, auth, money

| Component | Files | Status | Notes |
| :-- | :-- | :-- | :-- |
| RBAC | `0007_rbac.sql` (`app_members`, roles) | EXISTS | Platform owner/admin = global access. |
| Organizations + RLS helpers | `0018_organizations.sql` (`organizations`, `org_members`, `accessible_org_ids(min_role)`, `is_org_member`, `is_platform_admin`) | EXISTS | Every new table keys on `org_id` and uses these helpers. |
| Credits ledger | `0020_credits.sql` (`credit_accounts`, append-only `credit_transactions`, `credit_reservations` open→captured/released, `credit_prices` with `margin`), `0021` refunds, `0027` welcome credits, `modules/credits.py`, `command-center/lib/server/credits.ts` | EXISTS | Reserve/capture/release keyed by a text `job_id` — directly reusable for creative jobs (`cj:<id>`). Default org is exempt. |
| Priced one-shot charge pattern | `0030_paid_downloads.sql` (`request_download` charges at request, refund on failure in the DB) | EXISTS | Template for "quote + hold in one security-definer call". |
| API balance (USD cents) + keys + tiers | `0031_public_api.sql`, `lib/api/operations.ts`, `lib/api/keys.ts` (PR #250, open) | PARTIAL (unmerged) | Transport-independent operations module is the right pattern; reuse it for creative ops. |
| MCP server | `lib/api/mcp.ts`, `docs/MCP.md` (PR #251, open) | PARTIAL (unmerged) | Built on API key + API balance. **Conflicts with the new spec** — see §3.9 / decision D1. |
| Provider cost tracking | `modules/cost_ledger.py`, `video_costs` (schema.sql), `modules/spend_overview.py`, `tools/unit_economics.py`, `lib/unitEconomics.ts` | PARTIAL | Honest (USD null unless `CHRONOS_PRICE_*`), but keyed per **video/channel**. Creative jobs have no video → per-job cost rows needed. |

### 1.3 Generation (capability layer today)

| Capability | Files | Status | Notes |
| :-- | :-- | :-- | :-- |
| Provider protocols | `modules/providers.py` (Research/Image/Video/Voice/Publishing/Analytics `Protocol`s) | PARTIAL | Shape-only seams, no metadata (capabilities, IO, price, limits). |
| Image generation | `modules/image_providers.py` — OpenAI GPT Image, Gemini image, BFL FLUX.2, Ideogram 3, fal (sync `fal.run`), Leonardo | PARTIAL | Selected by **one global env var** per run (`CHRONOS_IMAGE_PROVIDER`), returns `None` on failure → falls back to stock (correct for the pipeline, wrong for a user who asked for a specific model). No edit / reference-image inputs. |
| Video generation | `modules/video_providers.py` (`GenericAsyncVideoClient` for Higgsfield, Kling, Seedance, Wan, Veo), `modules/minimax_client.py` | PARTIAL | Generic submit/poll with env-overridable paths. **Default model ids/endpoints are stale or unverified** (see §2.2). Text-to-video only; no image-to-video / refs / audio flags. |
| Provider task durability | `modules/provider_tasks.py` (task ledger on disk, `(provider, scene_id, prompt_hash)`) | PARTIAL | Correct idea (never pay twice), but file-based under `output/<slug>/`; creative jobs need it in the DB (`provider_task_id` on the job). |
| TTS | `modules/audio_mixer.py` (ElevenLabs v1 API + edge-tts), `config.ELEVENLABS_MODELS`, `0024_tts_model.sql`, `0025_voice_id.sql`, `0026_voice_previews.sql`, `tools/voice_previews.py`, `verify_voice()` | EXISTS (pipeline) / PARTIAL (standalone) | Voice/model validation exists; needs a standalone "text → audio asset" adapter. |
| SFX / music generation | local `assets/music` mixing only | MISSING | ElevenLabs sound effects / music have official APIs (§2). |
| Avatar / presenter | `modules/avatar.py` (`synthetic_only_guard`) | PARTIAL | Keep the synthetic-only rule for any lip-sync capability. |
| Provider lists (UI/validation) | `config.py`, `image_providers.KEY_ATTRS/DEFAULT_MODELS`, `lib/providers.ts`, `lib/imageProviders.ts`, `lib/runBackend.ts` (`VIDEO_PROVIDERS`), `0023` `render_job_params_valid`, `daily_video.yml` inputs | PARTIAL — **duplicated in ≥6 places** | The registry (§3.2) becomes the one source; the pipeline lists are migrated later, not in P0. |
| Router / modes | — | MISSING | Today: one provider per run from env; "no silent cross-fallback" already in `video_providers.py`. |
| LLM orchestration | `modules/gemini_client.py`, `modules/agent_planner.py` (pure planner), `modules/structured_output.py`, `modules/director.py` | PARTIAL | Reusable for the creative agent's *planning* step. |

### 1.4 Jobs, media, render

| Component | Files | Status | Notes |
| :-- | :-- | :-- | :-- |
| Job queue | `0017_render_jobs.sql`, `0019` (org scope), `claim_render_job` | PARTIAL | `channel_id NOT NULL` + regex, `kind in ('daily','repair')`, statuses `queued/running/succeeded/failed/cancelled`, strict `render_job_params_valid`, and 0031 hangs API-hold triggers on it. **Decision: new `creative_jobs` table, reusing the claim/heartbeat/credit patterns** (§3.4). |
| Media storage | buckets `previews` (0004; 50 MB cap; org-scoped by channel folder in 0018), `voice-previews` (0026), `publish-staging` (0029, service-only); worker volume `output/`; `worker_downloads` | PARTIAL | No asset table. Generated/pipeline assets live on the worker disk and in the Video IR `project.json`. Supabase free tier = 50 MB/object, 1 GB total → **masters cannot live there**. |
| File serving pattern | `app/api/downloads/[id]/route.ts` (RLS-checked row → file from read-only volume, path from numeric id only) | EXISTS | Template for media serving. |
| Video IR | `modules/video_ir.py`, `schemas/video_ir.schema.json` (scenes, assets with provenance, rights) | EXISTS | Import source for "open this pipeline video in the editor" (P1). |
| Scenes / storyboard / repair | `0011_video_scenes.sql` (`videos.scenes`), `0015_scene_repair_intents.sql`, `modules/scene_repair.py`, `lib/storyboard.ts`, `lib/sceneRepair.ts` | EXISTS | Pipeline-only; per-scene regenerate goes through `review_intents`. |
| ffmpeg render spec | `modules/render_spec.py` (`RenderSpec`: concat segments + **one** audio + one subtitle), `modules/render_backend.py` (normalise, Ken Burns, pool), `modules/render_dispatch.py`, `modules/ass_captions.py`, `modules/scene_render.py` | PARTIAL | Deterministic and tested, but concat-only: no trim in/out, no multiple audio tracks/volumes, no text overlays, no PiP. Extend (§3.6), don't replace. |
| Remotion scene renderer | `video-engine/`, `modules/remotion_renderer.py`, `modules/scene_remotion.py` | PARTIAL (off by default) | Motion-graphics cards; later a timeline clip type. |
| Project / timeline model | — | MISSING | |
| Media library UI / workspace | Studio page is style presets only (`app/(app)/[channel]/studio`), Create page = pipeline run form, Videos = pipeline outputs | MISSING | |

### 1.5 Publish, downloads, analytics, tests

| Component | Files | Status | Notes |
| :-- | :-- | :-- | :-- |
| YouTube upload + gate | `modules/youtube_uploader.py`, `modules/publish_gate.py`, `modules/publish_approval.py` | EXISTS | Untouchable (rule #2). |
| Cross-posting | `0028_social_accounts.sql`, `0029_publish_targets.sql`, `modules/social_publish.py` | PARTIAL | `publish_requests` is keyed by **`video_id`** (a pipeline video + publish gate). A timeline export is not a `videos` row → decision D4. |
| Paid downloads | `0030_paid_downloads.sql`, `modules/paid_downloads.py` | EXISTS | Reuse for exports (a render output is a master). |
| Series | `0006_content_series.sql`, `modules/series.py` | EXISTS | Out of Creative OS P0. |
| Analytics / learning | `modules/analytics_client.py`, `performance_analyzer.py`, `feedback_engine.py`, `learning_memory.py`, `0014` | EXISTS (pipeline) | Asset-level analytics = P4. |
| Tests / CI | `tests/` (≈150 unittest files), `command-center/tests` (vitest, incl. migration-text tests), `.github/workflows/tests.yml`, `frontend.yml` | EXISTS | Same commands gate every PR here. |

---

## 2. Provider verification

**How this was checked (and its limits).** Web search on 2026-09-30. Direct page
fetches of vendor docs were **blocked by this environment's egress proxy**
(`platform.minimax.io`, `kling.ai`, `docs.x.ai`, `docs.lumalabs.ai`,
`ai.google.dev`, `docs.dev.runwayml.com`), so every row below is "official
documentation located by search", **not** "a request succeeded". No key was
used. Per the spec, **no model is marked available in the registry until
`tools/probe_models.py` (PR 1) makes a real authenticated call and records
`verified_at`**. Model ids and prices must be re-read from the vendor page in
the PR that enables them.

### 2.1 Table

| Provider | Capability | Official API? | Source (official) | Auth | Async? | Notes |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| OpenAI — GPT Image | t2i, image edit (Images API; also Responses tool) | Yes (docs found) | https://developers.openai.com/api/docs/guides/image-generation | Bearer | Sync | Models listed: gpt-image-2, -1.5, -1, -1-mini. Already wired (`OpenAIImageClient`). |
| OpenAI — Sora 2 | t2v, i2v, audio in output | Yes (docs found) | https://developers.openai.com/api/docs/guides/video-generation | Bearer | Async (create → status → download) | sora-2 / sora-2-pro. Not wired. |
| Google — Gemini image ("Nano Banana") | t2i, edit, multi-image refs | Yes (docs found) | https://ai.google.dev/gemini-api/docs/nanobanana | `x-goog-api-key` | Sync | Wired (`GeminiImageClient`), default id `gemini-3.1-flash-image-preview` **not re-verified**. |
| Google — Imagen 4 | t2i | Yes (docs found, third-party summaries of Gemini API) | https://ai.google.dev/gemini-api/docs (Imagen) | `x-goog-api-key` | Sync | Not wired; ids seen as `imagen-4.0-*-preview-06-06` — **could not confirm current ids**. |
| Google — Veo | t2v, i2v, native audio | Yes (docs found) | https://ai.google.dev/gemini-api/docs/video | `x-goog-api-key` | Async (`predictLongRunning` → operation poll) | Docs reference `veo-3.1-generate-preview`; our default is **`veo-3.0-generate-preview` (stale)**. |
| Kling (Kuaishou) | t2v, i2v, extend, lip-sync, effects, Kolors image | Yes (docs found) | https://app.klingai.com/global/dev (keys), https://kling.ai/document-api | **JWT (HS256) signed from Access Key + Secret Key, 30 min expiry** | Async (task → query) | Our generic client sends the key as a plain Bearer → **will not authenticate as written**; default model `kling-v1` is old. Needs its own adapter. |
| Runway | t2v, i2v (Gen-4 Turbo, Gen-4.5), image, TTS/SFX (seed_audio) | Yes (docs found) | https://docs.dev.runwayml.com, https://dev.runwayml.com/models | Bearer + version header | Async (task poll) | Separate developer credit pool ($0.01/credit per third-party summary — confirm). Not wired. |
| Luma | t2v, i2v, keyframes, extend (Ray 2 / Ray 2 Flash); Ray 3.x via separate "Agents API" | Yes (docs found) | https://docs.lumalabs.ai/docs/python-video-generation, https://lumalabs.ai/dream-machine/api | Bearer | Async (generation poll) | Not wired. |
| MiniMax / Hailuo | t2v, i2v, subject ref; TTS; music | Yes (docs found) | https://platform.minimax.io/docs/api-reference/video-generation-i2v, https://www.minimax.io/news/minimax-hailuo-23 | Bearer | Async (task → query → file retrieve) | Docs show `MiniMax-Hailuo-2.3` on `api.minimax.io/v1/video_generation`. Our default `MINIMAX_H3_MODEL="MiniMax-H3"` — **could not verify that this is a video-generation model id**; probe before relying on it. |
| ByteDance Seedance | t2v, i2v, first/last frame, reference-to-video, optional audio | Yes (BytePlus ModelArk docs found) | https://docs.byteplus.com/en/docs/ModelArk/1587798 | Bearer (ModelArk key) | Async (task) | Our default base URL is **Volcengine China (`ark.cn-beijing.volces.com`)**; international accounts use BytePlus ModelArk. Region/account decision needed. |
| Alibaba Wan | t2v, i2v, reference-to-video (Model Studio / DashScope intl) | Docs exist (found only via third-party integration docs) | Alibaba Cloud Model Studio (DashScope international) | Bearer | Async (task → `/api/v1/tasks/{id}`) | **Could not reach an Alibaba-hosted page**; integration docs name wan2.6/2.7. Our default `wan2.1-t2v-turbo` is old. |
| xAI — Grok Imagine | t2i, t2v, i2v with audio | Yes (docs referenced) | https://docs.x.ai (image / video guides) | Bearer | Video async | **Could not fetch docs.x.ai**; only third-party summaries. Treat as unverified. |
| ElevenLabs | TTS (v3, multilingual v2, flash/turbo), SFX, music, dubbing, STT | Yes (docs found) | https://elevenlabs.io/docs/overview/models, https://elevenlabs.io/developers | `xi-api-key` | Sync (TTS/SFX); music may be long-running | TTS already live in the pipeline. |
| Black Forest Labs | t2i, edit (FLUX.2 pro/max/flex/klein) | Yes (docs found) | https://docs.bfl.ai/quick_start/generating_images | `x-key` | Async (`polling_url`; result URL expires ~10 min) | Wired (`FluxClient`). Download immediately — result URLs expire. |
| Ideogram | t2i (V3: flash/turbo/default/quality), text-in-image | Yes (docs found) | https://docs.ideogram.ai (endpoint `api.ideogram.ai/v1/ideogram-v3/generate`) | `Api-Key` | Sync | Wired (`IdeogramClient`). |
| Higgsfield | aggregator of 50+ image/video models | Yes (docs found) | https://docs.higgsfield.ai/docs/api-reference/overview.md | key | Async | Its docs say model request schemas are being redesigned → our `/v1/text2video` path is **unverified**. |
| fal.ai | aggregator (1000+ models), queue + webhooks, pricing endpoint | Yes (docs found) | https://fal.ai/docs/model-endpoints/queue | `Key` header | Async queue (we use sync `fal.run` today) | Useful as a **secondary route** to a model, never a silent substitute (§3.3). |
| Replicate | aggregator; "official models" with stable API and predictable pricing | Yes (docs found) | https://replicate.com/docs/topics/models/official-models.md | Bearer | Async predictions | Not wired. |
| Leonardo | t2i | Wired, **not re-checked in this audit** | — | Bearer | Async | Keep as is; include in the first probe run. |

### 2.2 Findings from the table

1. **Several shipped defaults are stale or wrong-shaped**: Kling auth (JWT, not
   Bearer), Veo 3.0 id, Seedance China region, Wan 2.1 id, MiniMax-H3 as a
   video id, Higgsfield path. They are opt-in and off by default, so nothing is
   broken in production — but the registry must not import them as "available".
2. The registry therefore separates **`api_documented`** (a URL a human checked)
   from **`verified_at`** (a probe call succeeded with our key) and exposes only
   verified models to users.
3. Aggregators (fal, Replicate, Higgsfield) are modelled as **routes** to a
   model, not as models. Route choice is visible to admins and never changes
   what the user picked.

---

## 3. Target architecture (reuse first)

```
 Web (session)      REST /api/v1 (API key)      MCP (/api/mcp)
        \                 |                        /
         lib/creative/operations.ts   ← one transport-independent module (pattern of lib/api/operations.ts)
                          |  rpc() with the ANON key
                          v
   SQL (security definer): quote · reserve credits · create/cancel job · timeline revisions · media grants
                          |  rows
                          v
   creative worker (Python, service key): router failover · provider adapters · poll · ingest to library · render
                          |
          modules/capabilities/* → existing clients (image_providers, video_providers, minimax_client, audio_mixer)
                          |
          media volume on Hetzner  ·  render_spec/render_backend (ffmpeg)  ·  credits ledger (0020)
```

### 3.1 Where each piece lives

| Layer | Lives in | Why there |
| :-- | :-- | :-- |
| Authorization, quotas, prices, holds, job creation, timeline writes | **SQL** (security-definer functions, RLS) | The only place all three transports share that also holds the authority. Browser/API/MCP cannot bypass it (rule #3; same design as 0030/0031). |
| Transport adapters + input validation | **Next server** `command-center/lib/creative/*` | Thin: validate shapes, call RPCs, map errors. No keys, no provider calls. |
| Provider calls, polling, failover, file ingest, render | **Python worker** `modules/capabilities/*`, `modules/creative_worker.py`, `tools/creative_worker.py` | Provider keys already live only in the worker env; ffmpeg and the render engine are there. |
| Model registry data | `schemas/model_registry.json` (reviewed in git) → synced into SQL table `model_registry` | Python and TS read the same JSON; SQL needs it to price and validate server-side. |

### 3.2 Model registry (new, minimal)

One JSON document, validated by `schemas/model_registry.schema.json`, one entry per model:

```
id                 "veo-3.1"                     stable Nightshift id (never the vendor string)
provider           "google"
route              [{"via":"google","vendor_model":"veo-3.1-generate-preview"}, {"via":"fal", ...}]
capabilities       ["t2v","i2v"]                 t2i|edit|t2v|i2v|v2v|extend|lipsync|tts|sfx|music|stt|upscale|bg_remove
inputs / output    {"text":true,"image_refs":{"max":1}} / "video"
resolutions        ["720p","1080p"]   aspect_ratios ["16:9","9:16"]   durations_s [4,6,8]
audio_out          true
async              true
api_documented     {"url": "...", "checked_at": "2026-09-30"}
verified_at        null until tools/probe_models.py succeeds (stored in SQL, not in git)
availability       hidden | beta | ga | disabled   (hidden until verified)
pricing            {"unit":"second","provider_usd_per_unit":null,"source_url":"...","as_of":null}
credit_unit        "model:veo-3.1:second"         a credit_prices unit (0020) — unset = cannot be sold
entitlement        "paid" | "any"                 (paid = org has a purchase, the 0031 rule)
limits             {"max_prompt_chars":2000,"max_concurrent_per_org":2}
quality_tier       1..5 (manual), speed_tier 1..5 (from measured p50 once jobs exist)
adapter            "video.google_veo"             Python adapter key
```

- **Pricing → credits** reuses `credit_prices` (0020): `credits = quantity ×
  credits_per_unit × (1 + margin)`. A model whose `credit_unit` has no row is
  **not sellable** (quote returns `unpriced`, never 0 — rule #5).
- The existing pipeline lists (config.py, `lib/imageProviders.ts`,
  `lib/runBackend.ts`, 0023, the workflow) are left alone in P0 and migrated to
  read the registry in a later cleanup PR, so the autonomous pipeline is not
  touched while the new core lands.

### 3.3 Capability layer, adapters, router, failover

- `modules/capabilities/base.py`: `CapabilityRequest` (capability, params,
  input asset paths), `Adapter` protocol with `submit() → ProviderTask`,
  `poll(task) → pending|succeeded(files)|failed(code)`, `supports(request) →
  list[str] problems` (capability detection from the registry entry + adapter
  self-check). Adapters **wrap** the existing clients: `OpenAIImageClient`,
  `GeminiImageClient`, `FluxClient`, `IdeogramClient`, `FalImageClient`,
  `MiniMaxClient`, `GenericAsyncVideoClient`, ElevenLabs TTS from
  `audio_mixer`. Unlike the pipeline wrappers they **raise typed errors**
  (`auth`, `quota`, `invalid_input`, `content_policy`, `provider_down`) instead
  of returning `None`, because a creative user asked for that specific output.
- **Router** (`route_model()` in SQL, pure and deterministic, so web/API/MCP
  quote identically): input = capability + constraints (resolution, duration,
  refs, audio) + mode; output = ordered candidate list + quote.

| Mode | Picks | Failover allowed |
| :-- | :-- | :-- |
| `EXACT` (user picked a model) | that model | **Never.** Fails with the remedy. Another *route* to the same model (e.g. fal) only if the user/org enabled "allow alternate route". |
| `AUTO` | best quality/price balance among verified, entitled models | to the next candidate of **equal or higher quality tier** and **≤ the hold** |
| `CHEAP` | lowest credit quote | to next candidate ≤ hold |
| `FAST` | lowest measured p50 latency | to next candidate ≤ hold |
| `QUALITY` | highest quality tier | only to an equal tier |

  Every job stores `requested_model`, `mode`, `routed_model`, `route`,
  `fallback_from`, `fallback_reason`; the UI shows "made with X because Y
  failed". Retries after a provider-side failure **re-use the stored
  `provider_task_id`** (never double-submit — the `provider_tasks.py` rule,
  moved into the DB).

### 3.4 Durable jobs: new `creative_jobs`, not a generalized `render_jobs`

Why a new table: `render_jobs` is channel-bound (`channel_id NOT NULL`),
tightly validated per pipeline kind, its statuses differ, the worker runs
`main.py` for it, and 0031 attaches API-hold triggers to it. Widening it would
touch the autonomous pipeline and the open API PR. What is reused: the claim
function shape (`for update skip locked`, heartbeat, stale re-queue bounded by
`max_attempts`), the secret scrubber, `credit_reservations`, and the 0031
payer pattern.

Statuses: `queued → planning → running → provider_pending → processing →
rendering → completed | failed | cancelled | expired`. `planning` is used by
agent jobs; `provider_pending` holds a persisted `provider_task_id`;
`processing` = download/probe/ingest; `rendering` = ffmpeg. `expired` = never
claimed within its TTL (hold released). A `jobs_overview` view unions
`render_jobs` (mapping `succeeded → completed`) and `creative_jobs` for one
"Jobs" page.

Worker: `tools/creative_worker.py`, same image as the pipeline worker, new
compose service `creative-worker` (bounded concurrency, e.g. 4 provider jobs +
1 render), so creative jobs never wait behind a 30-minute pipeline render.

### 3.5 Media library and storage

- **Masters on the Hetzner volume** (new named volume `media`, rw for the two
  workers, ro for web). Supabase Storage stays for the existing small buckets;
  its 50 MB/object and 1 GB total caps rule it out for masters.
- Served by `GET /api/media/[id]` (Next): RLS read of the asset row under the
  user's session, then the file from the ro volume by **id-derived path only**
  (0030 pattern). Short-lived links for `<video>`/`<img>` and for API/MCP
  clients use an HMAC-signed URL (`exp`, `asset_id`, `variant`) with a new
  `MEDIA_URL_SECRET` in web + worker env (not a Supabase key).
- Uploads: `POST /api/media/upload` streams into a size-capped rw **staging**
  volume (web needs one rw mount), then a `creative_jobs` row kind `ingest`
  makes the worker sniff MIME, ffprobe, strip metadata, generate a thumbnail and
  a proxy, and move it into `media/`. Nothing a user uploads is served before
  ingest.
- Per-org storage quota (bytes) enforced in SQL at upload/ingest; soft-delete
  plus GC like `scene_cache_gc.py`. RAID1 is **not a backup** → off-site copy is
  a P3 item.
- On a web host without the volume (Vercel) the library says so (as downloads do).

### 3.6 Project / timeline, rendered by the existing engine

- Timeline document (JSON Schema `schemas/timeline.schema.json`, validated in
  both Python and SQL): `{version, width, height, fps, tracks:[{id, kind:
  "V"|"A"|"T", clips:[{id, asset_id, start_s, in_s, out_s, volume, fit,
  motion, transition}]}], captions:[{start_s, end_s, text, style}]}`.
- Stored as **append-only revisions** (optimistic concurrency on `rev`).
  Deterministic edits (trim, move, split, delete, reorder, captions text,
  volume) are revisions → **free**.
- `modules/timeline_render.py` converts a revision into a `RenderSpec`.
  `render_spec.py` is **extended backwards-compatibly** (new optional fields
  default to today's behaviour): `Segment.in_s` (trim), `audio_tracks[]` with
  offset/volume (ffmpeg `adelay`+`amix`, replacing the single `audio_path`
  only when present), `overlays[]` for text (via `ass_captions.py`). P0 keeps
  one primary video lane (concat) — overlapping video (PiP) is P2.
- Render = `creative_jobs` kind `render`; output is registered as a new
  `media_assets` row (kind `video`, source `render`) that downloads (0030
  pattern) and publish (D4) can use.

### 3.7 Workspace UI (states)

Pages under `app/(app)/[channel]/*` inherit the channel URL model, but
Creative OS is org-scoped, so a new top-level group `app/(studio)/studio/*` is
proposed, with the organization resolved server-side from the session and an
org switcher (not from a channel in the URL). Every job/asset view has
explicit states: `empty · quoting · insufficient_credits (with top-up link) ·
queued · running/provider_pending (elapsed, not a fake %) · processing ·
completed · failed (reason + remedy + "refunded N credits") · cancelled ·
expired · model_unavailable`. All strings in `lib/i18n/{en,ru,uz}.ts`.

### 3.8 Creative agent

The LLM is a **planner, not an actor**: a `creative_jobs` row kind `agent`
enters `planning`; the worker (which has the LLM key — `gemini_client.py`,
`structured_output.py`) returns a typed plan: a list of tool calls from a
fixed whitelist (`generate_image`, `generate_video`, `tts`, `add_to_timeline`,
`render`) with a total quote. The plan is shown; **the user confirms under
their own session**, and each step is created through the same SQL functions
as a manual action (role, entitlement, credits, limits checked
deterministically). A plan above the org's auto-approve threshold (default 0)
always needs confirmation. The worker never executes an agent step with the
service key on a user's behalf.

### 3.9 Web / REST / MCP on one core — and the payer conflict (D1)

`lib/creative/operations.ts` exposes each operation once (`quote`,
`createGeneration`, `getJob`, `cancelJob`, `listAssets`, `getAssetUrl`,
`saveTimeline`, `render`); REST routes and MCP tools are thin wrappers, exactly
as `lib/api/operations.ts` is in PR #250/#251.

**Conflict to decide (not resolved here):** the owner's new spec says **MCP
spends the web account's credits**, REST spends the **separate USD API
balance**. PR #251 builds MCP on **API keys + API balance**. Proposal:

- Introduce a **payer** in the SQL entry points: `payer = 'credits'` (org
  credit ledger, 0020) or `payer = 'api_balance'` (0031 holds). Operations code
  is identical; only the auth door picks the payer.
- **Recommended:** MCP authenticates the *user* with OAuth (MCP authorization
  spec → Supabase Auth session) and pays with **credits**; REST keeps API keys
  and the USD balance. PR #251's API-key MCP can remain as a "developer MCP"
  (same tools, `api_balance` payer) or be closed — owner's choice.
- Until D1 is decided, creative operations ship on web first; REST/MCP
  exposure is P1 and depends on D1.

---

## 4. Data model (migrations from 0033)

All additive, idempotent, `org_id`-keyed, RLS via 0018 helpers, service role
for the worker, anon gets nothing, browsers never update/delete job rows.

| Migration | Adds | RLS / who | Money |
| :-- | :-- | :-- | :-- |
| **0033_model_registry.sql** | `model_registry` (id, provider, capabilities text[], spec jsonb, availability, verified_at, verified_by, credit_unit, entitlement); `model_probe_runs` (append-only). Function `sellable_models(capability)` | select: signed-in users see `availability in ('beta','ga') and verified_at is not null`; platform admin sees all; writes: platform admin + service role | none |
| **0034_creative_jobs.sql** | `creative_jobs` (id, org_id, kind `generate|ingest|render|agent`, capability, mode, requested_model, routed_model, route, fallback_from/reason, params jsonb (validated per capability), status, provider_task_id, attempts, heartbeat_at, ttl, payer, credit_ref, quoted_credits, charged_credits, error_code, error, result_asset_ids, parent_job_id, requested_by); `creative_job_events` (append-only status log); functions `quote_creative_job`, `create_creative_job` (session) / `api_create_creative_job` (0031 key-hash entry, after D1), `cancel_creative_job`, `claim_creative_job` (service), `finish_creative_job` (captures or releases in the same transaction), `expire_creative_jobs` | select: viewer+ of org; create: editor+ (same as buying downloads); worker: service role | reserve via `reserve_credits(org, 'cj:<id>', quote)` at create; `start_credit_reservation` at claim; `capture_credits(actual ≤ hold)` on success; `release_credits` on fail/cancel/expire. Exempt org unchanged. |
| **0035_provider_costs.sql** | `creative_job_costs` (job_id, org_id, provider, route, vendor_model, unit, quantity, usd_estimate null-unless-priced, price_source, recorded_at); view `creative_economics` (credits captured vs provider USD per model/day) | **platform admin only** (never org members — internal economics) | reporting only |
| **0036_media_assets.sql** | `media_assets` (id uuid, org_id, project_id, kind image/video/audio/caption, storage `local`/`supabase`, storage_key (id-derived), bytes, mime, width, height, duration_s, sha256, source `generated|upload|render|pipeline`, provenance jsonb (provider, model, prompt_hash, job_id, rights status), parent_asset_id, version, created_by, deleted_at); `org_storage_quota`; functions `request_upload`, `register_asset` (service), `soft_delete_asset` | select: viewer+; upload/delete: editor+; register: service role | free (storage quota only) |
| **0037_creative_projects.sql** | `creative_projects` (id, org_id, title, width, height, fps, current_rev, created_by); `timeline_revisions` (project_id, rev, doc jsonb, created_by, created_at; append-only); functions `timeline_doc_valid(jsonb)`, `save_timeline(project, base_rev, doc)` (checks every `asset_id` belongs to the same org), `request_render(project, rev)` | select: viewer+; edit: editor+ | edits free; render per D3 |

Credit flow for one generation: quote (router + `credit_prices`) → user sees
it → `create_creative_job` locks the credit account, reserves, inserts the job
(one transaction) → worker claims + `start_credit_reservation` → provider →
success: capture the quote (or the metered amount if lower) and write
`creative_job_costs`; failure/cancel/expire: release in full. A job without an
open hold is refused by the worker when enforcement is on (the
`NIGHTSHIFT_CREDITS_ENFORCE` rule, reused).

---

## 5. Roadmap (PR by PR)

Effort: S ≤ 1 day · M 2–3 days · L 4–6 days (implementation + review fixes).
Every PR: Python `unittest`, `tsc`, `next lint`, `vitest`, `next build`; a
migration PR also gets a vitest migration-text test (as `api-migration.test.ts`).

### P0 — core (no user-facing generation until P0.4 lands behind a flag)

**PR 1 — Model registry + capability layer** (M–L)
- Files: `schemas/model_registry.json`, `schemas/model_registry.schema.json`,
  `modules/model_registry.py`, `modules/capabilities/{base,image,video,audio}.py`
  (adapters for the D2 set — Veo, Imagen, Gemini image, OpenAI image,
  ElevenLabs, Kling (JWT), MiniMax Hailuo, Runway, Luma — plus FLUX.2,
  Ideogram, Seedance (BytePlus, D5) and Wan; each calls the vendor's
  documented endpoint, and all ship `hidden`),
  the stale pipeline defaults in `modules/video_providers.py` fixed behind the
  existing off-by-default flags,
  `tools/probe_models.py` (admin-run, one cheapest real call per model, writes
  `verified_at`), `command-center/lib/creative/registry.ts`, migration **0033**.
- Tests: registry validates against schema; every `adapter` key resolves; an
  unverified model is never returned by `sellable_models`; adapters map vendor
  errors to typed codes (auth vs quota vs policy); no key ever appears in a
  log line (scrubber test); Kling JWT expiry.
- Owner steps: apply 0033; run `probe_models.py` on the worker with the keys
  already in `.env.worker`; approve which verified models go `beta`.

**PR 2 — creative_jobs + credits + creative worker** (L)
- Files: migration **0034** (+ **0035** costs), `modules/creative_worker.py`,
  `tools/creative_worker.py`, `deploy/docker-compose.yml` (`creative-worker`
  service, profile `worker`), `command-center/lib/creative/operations.ts`
  (`quote`, `createGeneration`, `getJob`, `cancelJob`), routes
  `app/api/creative/{quote,jobs,jobs/[id]}`.
- Tests: hold = quote; capture ≤ hold; release on fail/cancel/expire; two
  concurrent creates cannot overspend (row lock); a crashed job resumes by
  polling its stored `provider_task_id` (no second submit); EXACT mode never
  fails over; AUTO failover stays ≤ hold and ≥ tier; cross-org job read denied;
  exempt org holds nothing; unpriced model refused.
- Owner steps: apply 0034/0035; set `credit_prices` rows for the beta models;
  `docker compose --profile worker up -d creative-worker`.

**PR 3 — Media asset library + storage** (M–L)
- Files: migration **0036**, `modules/media_library.py` (ingest: MIME sniff,
  ffprobe, thumbnail/proxy, id-derived paths), `command-center/app/api/media/*`
  (serve, signed URL, upload to staging), `lib/server/media.ts`, compose
  volumes `media` + `media_staging`, `MEDIA_URL_SECRET`.
- Tests: path traversal impossible (id-only paths); signed URL expiry and
  tamper; cross-org asset denied; quota enforced; upload of a non-media file
  rejected at ingest; generated outputs from PR 2 land as assets with provenance.
- Owner steps: apply 0036; add `MEDIA_URL_SECRET` to web + worker env; set the
  default per-org quota.

**PR 4 — Project/timeline schema + render adapter** (L)
- Files: migration **0037**, `schemas/timeline.schema.json`,
  `modules/timeline.py`, `modules/timeline_render.py`, backwards-compatible
  extension of `modules/render_spec.py` / `modules/render_backend.py` (trim,
  audio tracks, text overlays), `lib/creative/timeline.ts`,
  `app/api/creative/projects/*`.
- Tests: every existing `test_render_spec` / `test_render_backend` test passes
  unchanged (old specs render bit-for-bit the same command); golden ffmpeg
  argv for a 3-clip + music + VO + caption timeline; same revision → same argv
  (determinism); timeline referencing another org's asset refused; stale
  `base_rev` refused.
- Also (D3): `credit_prices` units `export_render_minute` (~3–5 credits/min)
  and `export_render_minimum`; the render is charged when requested and
  refunded if it fails (the 0030 pattern).
- Owner steps: apply 0037; review the two export prices.

### P1 — first usable workspace (each M)

- PR 5: Workspace shell (`app/(studio)/studio`), generate panel (image), job
  tray (Realtime), library grid, all UX states, i18n ×3.
- PR 6: Video + TTS generation in the panel; mode selector (AUTO/CHEAP/FAST/
  QUALITY/EXACT) with the quote shown before confirm.
- PR 7: Admin economics page (`creative_economics`, platform admin only) +
  per-model enable/disable switch.
- PR 8a: REST `/api/v1/creative/*` on the shared operations, API key +
  USD API balance (`payer = api_balance`, D1).
- PR 8b: MCP creative tools with **OAuth sign-in** (web account) paying from
  **site credits** (`payer = credits`, D1). PR #251's API-key MCP remains an
  optional developer door on the same tools.
- PR 9: "Open in editor" — import a pipeline video's Video IR into a project
  (assets registered as `source='pipeline'`).

### P2 — editor (M–L each)

- PR 10: Timeline editor UI (tracks V/A/T, trim/split/move, preview from proxy
  renders, not a browser compositor).
- PR 11: Captions from existing Whisper path (`subtitle_generator.py`) as a
  priced AI op; manual caption editing free.
- PR 12: Export presets (9:16 / 16:9 / 1:1) + downloads via the 0030 pattern.
- PR 13: Publish an export (D4): the export becomes a `videos` row, then the
  existing publish gate, approvals and `publish_requests` apply unchanged.
- PR 14: PiP / overlapping video lanes in `render_spec`.

### P3 — agent and scale

- PR 15: Creative agent (plan → confirm → execute under the user's session).
- PR 16: More adapters after probes (Sora, xAI, fal/Replicate routes), each
  its own PR. (Runway, Luma, Seedance and Wan already land in PR 1, per D2/D5.)
- PR 17: Off-site backup of `media/` (Hetzner Storage Box or S3-compatible).
- PR 18: Migrate pipeline provider lists to the registry (removes the 6 copies).

### P4 — learning loop

- Asset-level analytics after publish; router quality tiers informed by
  measured outcomes and user ratings (advisory, human-approved, as the
  existing learning loop is).

---

## 6. Risks, costs, limits

### 6.1 Cost and pricing

- 1 credit ≈ $0.01 retail (0031's own reasoning); the pipeline sells ~60
  credits per finished minute. Generative video is priced **per second by the
  provider** and is far more expensive than a pipeline minute: at a
  third-party-reported $0.05–$0.12 per second (Runway Gen-4 Turbo / 4.5) an
  8 s clip costs $0.40–$0.96 → **~120–290 credits at the usual ~3× markup**,
  more than a whole pipeline minute. Premium models cost more. Welcome credits
  (100) buy very little video → the quote-before-spend UX is mandatory.
- Every price is **pinned from the vendor's page in the enabling PR** and
  stored with `source_url` + `as_of`; this plan asserts none of them as fact.
- Provider-side price changes silently erode margin → the admin economics view
  flags models whose measured USD/credit exceeds a threshold, and the admin can
  disable them in one click.

### 6.2 Risks

| Risk | Mitigation |
| :-- | :-- |
| Double spend on crash / retry | Hold before submit; `provider_task_id` persisted before polling; resume = poll. |
| Silent downgrade | EXACT never fails over; every substitution recorded and displayed. |
| Cross-tenant leakage of media | Org-keyed RLS on every table; id-derived file paths; signed URLs bound to asset + expiry; tests per PR. |
| LLM agent spending | Planner only; execution under the user's session through the same SQL checks; per-session budget. |
| Disk fills (512 GB RAID1 shared with pipeline masters) | Per-org quotas, GC, proxy-only previews, off-site backup (P3), alert via `resource_monitor.py`. |
| Stale model ids / endpoints | Registry + probe; `verified_at` older than N days → back to `beta`/hidden. |
| Pipeline regressions | P0 does not touch `main.py`, `render_jobs`, the publish gate, or the pipeline provider lists. `render_spec` changes are additive with bit-for-bit tests. |
| Content policy / likeness | Surface provider `content_policy` errors as such; keep `synthetic_only_guard` for any lip-sync/avatar capability. |

### 6.3 What cannot be built now, and why

- **Self-hosted open models** (Wan/Hunyuan/Flux local): the AX42 has no GPU.
- **Masters in Supabase Storage**: free tier 50 MB/object, 1 GB total.
- **Real-time multi-user co-editing**: needs CRDT/OT infrastructure; revisions
  with optimistic concurrency cover single-editor + conflict detection.
- **Frame-accurate in-browser preview of the full timeline**: needs a browser
  compositor (Remotion Player or similar; Remotion's company licence terms must
  be checked first). P2 uses server proxy renders.
- **Per-org BYOK provider keys**: keys live only in worker env today; adding a
  Vault-backed BYOK is a separate security design.
- **Unverified providers** (xAI, current Wan, Higgsfield schemas, MiniMax-H3 as
  video): not offered until a probe succeeds.

### 6.4 Owner decisions

Decided by the owner — see §6.5. The original proposals are kept for the record.

| # | Question | Proposal (superseded by §6.5) |
| :-- | :-- | :-- |
| D1 | MCP payer: web credits (new spec) vs API balance (PR #251) | OAuth MCP on credits; keep REST on API balance; optional developer MCP on API keys. |
| D2 | Which models go `beta` first | Those already wired and verified by probe. |
| D3 | Is timeline **render/export** free? | Free up to a daily allowance, then a small per-minute price. |
| D4 | Publishing a timeline export | A `videos` row per export, so the existing gate and `publish_requests` apply unchanged. |
| D5 | Seedance region | BytePlus international. |

### 6.5 Decisions (owner, final)

| # | Decision | What it changes in this plan |
| :-- | :-- | :-- |
| **D1** | **MCP pays from site credits**; the user signs in to MCP with **OAuth** (their web account). **REST keeps API keys + the USD API balance.** PR #251 stays as an **optional developer MCP** (API key + API balance). | SQL entry points take a `payer` (`credits` \| `api_balance`) from PR 2 on. The OAuth MCP door is PR 8b; REST creative endpoints are PR 8a. |
| **D2** | **Broad beta set**: Google (Veo video; Imagen and Gemini image), OpenAI image, ElevenLabs, Kling, MiniMax Hailuo, Runway, Luma. Each is enabled **only once its adapter passes a real probe with the owner's key**; until then the registry marks it unavailable. | PR 1 ships adapters for all of them (plus the already-wired FLUX.2 / Ideogram, and Seedance / Wan fixes). Availability stays `hidden` and the DB refuses `beta`/`ga` without `verified_at`. |
| **D3** | **Timeline edits free; final render/export charged a small credit fee** (like HD downloads, ~3–5 credits per minute), through `credit_prices` units. | PR 4 adds `credit_prices` units `export_render_minute` and `export_render_minimum`; `request_render` charges and refunds on failure, the 0030 way. |
| **D4** | **Exports publish through the existing publish gate and approvals.** | PR 13 registers an export as a `videos` row and uses `publish_requests` unchanged. No second publish path. |
| **D5** | **Seedance via the international BytePlus region.** | PR 1 changes the Seedance default base URL to BytePlus ModelArk (`ark.ap-southeast.bytepluses.com`). |

---

## 7. Xulosa (o'zbekcha, egasi uchun)

- Bu PR faqat **reja**: kod yo'q. Audit README bo'yicha emas, manba kod bo'yicha qilindi.
- Asos tayyor: tashkilotlar + RLS (0018), kreditlar ledger'i (0020/0021), navbat
  worker'i (0017), ffmpeg render spec, Video IR, pullik yuklab olish (0030) —
  bularni **qayta ishlatamiz**, qaytadan yozmaymiz.
- Yetishmaydi: model reestri, umumiy creative job, media kutubxona, loyiha/timeline.
  Bular P0 dagi 4 ta PR (migratsiyalar **0033–0037**, 0032 band).
- `render_jobs`ni kengaytirmaymiz — yangi `creative_jobs` jadvali va alohida
  `creative-worker` jarayoni (rasm generatsiyasi 30 daqiqalik render ortida kutmasin).
- Provayderlar: rasmiy hujjatlar qidiruv orqali topildi, lekin to'g'ridan-to'g'ri
  ochib bo'lmadi (tarmoq cheklovi). Model faqat **real API chaqiruvi** muvaffaqiyatli
  bo'lgandan keyin foydalanuvchiga ko'rsatiladi.
- Topilgan muammolar: Kling JWT talab qiladi (bizda oddiy Bearer), Veo/Wan/Kling
  model id'lari eskirgan, Seedance Xitoy regioniga qarab turibdi, "MiniMax-H3"
  video model ekanini tasdiqlab bo'lmadi. Hozir hammasi o'chiq, lekin reestrga
  "tayyor" deb kirmaydi.
- Masterlar Supabase'da emas, Hetzner diskida saqlanadi (50 MB cheklov);
  imzolangan qisqa muddatli havolalar bilan beriladi.
- Foydalanuvchi tanlagan model **hech qachon** jimgina almashtirilmaydi; AUTO/CHEAP/FAST
  rejimlarda almashtirish bo'lsa, u yozib qo'yiladi va ko'rsatiladi.
- AI amallar kredit oladi (oldindan hold, muvaffaqiyatda capture, xatoda qaytarish);
  qo'lda tahrirlash bepul. Provayder xarajati faqat admin ko'radi.
- **Qarorlar (egasi):** D1 — MCP OAuth orqali kirib sayt kreditlaridan to'laydi, REST
  API kalit + USD API balansda qoladi, PR #251 ixtiyoriy developer MCP bo'lib qoladi.
  D2 — keng beta: Google (Veo, Imagen/Gemini), OpenAI rasm, ElevenLabs, Kling,
  MiniMax Hailuo, Runway, Luma — har biri egasining kaliti bilan real probe'dan
  o'tgandan keyingina yoqiladi. D3 — timeline tahrirlash bepul, yakuniy render/eksport
  daqiqasiga ~3–5 kredit. D4 — eksport mavjud publish gate va tasdiqlar orqali.
  D5 — Seedance xalqaro BytePlus orqali.
