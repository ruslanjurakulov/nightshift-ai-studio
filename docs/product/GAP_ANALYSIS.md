# Nightshift: gap analysis against the Universal AI Content OS brief

Audited: `origin/main` at `c94620b` (2026-10-02), read from the code, migrations and
tests. The README and the older plan documents were treated as claims to check,
not as evidence. Where a document disagrees with the code, the code wins and the
document is listed as stale in §2.

Status words used below:

| Word | Meaning |
| :-- | :-- |
| **implemented** | code path exists end to end, with tests |
| **partial** | real code exists, but a named part of the pillar is missing or not wired |
| **broken** | code exists and does not do what it says (none found at this commit, see §2) |
| **missing** | no code for it |
| **needs refactor** | it works, but in a shape that blocks the pillar (duplicated stacks, hard-wired vendor) |
| **needs external provider** | cannot be finished without a vendor account or API the owner must open |
| **needs infrastructure** | cannot be finished without a host, GPU, queue or setting that does not exist yet |

Migration numbers in use: up to `0073` on main, `0074` taken by open PR #355.
New work in this document starts at **0075**.

---

## 1. Pillar by pillar

### 1.1 Goal-driven Auto mode and Pro mode — **partial**

- Goal to plan: `command-center/lib/assistant/plan.ts` (the "Assistant": one goal,
  a list of steps, one total price, one confirm), UI in
  `components/assistant/AssistantPlanner.tsx`, mounted on `/[channel]/create` and
  in `components/home/HomeHub.tsx`. The planner is **deterministic keyword
  parsing** (it says so in its header); it calls no model and prices through
  `/api/creative/quote` and `/api/credits/estimate`.
- Multi-step chains: workflow apps, `supabase/migrations/0073_workflow_apps.sql`
  (`quote_workflow`, `start_workflow_run`, `advance_workflow_run`), UI under
  `/[channel]/workflows`.
- Pro surfaces: Studio (`lib/creative/studio.ts`, `/[channel]/studio`), timeline
  editor (`0054_editor_projects.sql`, `/[channel]/editor/[id]`), storyboard edit
  (`0058_storyboard_edit.sql`).
- **Missing:** an explicit Auto/Pro switch. There is no stored preference and no
  UI that hides model pickers in an "Auto" mode. Auto cannot pick a model for the
  person because the router (1.3) refuses every mode except `exact`.

### 1.2 Scene-based video, per-scene regeneration, region retake — **partial / missing**

- Scene model: Video IR v1, `modules/video_ir.py` (`VideoProject`, scenes with
  measured `start_s`/`end_s`, assets with provenance and `rights.status`), schema
  `schemas/video_ir.schema.json`. Scene render and cache: `modules/scene_render.py`
  (`render_project`), `modules/scene_remotion.py`, `video-engine/` (Remotion).
- Storyboard before render: `0057_storyboard_review.sql` (`approve_storyboard`),
  `0058_storyboard_edit.sql` (`save_storyboard_edits`, `reopen_storyboard`),
  `modules/storyboard_review.py`.
- Per-scene regeneration: `modules/scene_repair.py` (`main.py --repair-scenes`),
  request rows from `0015_scene_repair_intents.sql` (`review_intents.action =
  'regenerate_scene'`), job kind `repair` in `render_jobs` (`0017_render_jobs.sql`),
  UI helper `command-center/lib/sceneRepair.ts`. Limits, from the module's own
  header:
  - it re-fetches **stock (Pexels) footage only**; a scene that was AI b-roll
    gets stock replacement (recorded in `previous_sources`, cut held for review).
    This is a quality substitution the person did not choose: **needs refactor**
    against CLAUDE.md #4;
  - it repairs only an **unfinished** run (checkpoint must exist); a published
    video cannot be repaired;
  - no prompt or model override per scene; no price shown for the repair.
- **Region retake (mask a region of a frame or clip and regenerate it): missing.**
  No mask/inpaint parameter exists in `modules/capabilities/base.py`
  (`CapabilityRequest`) or any adapter; `remove_bg` is declared as a capability
  constant but no registry model provides it. **Needs external provider** (a
  masked image/video edit API) once built.

### 1.3 Provider interfaces, adapters, Model Router — **partial / needs refactor**

- Adapter layer: `modules/capabilities/` (`base.py`: `HttpAdapter`,
  `CapabilityRequest`, `ProviderTask`, `PollResult`, typed `AdapterError` codes
  `auth`/`quota`/`rate_limited`/`policy`/...; `image.py`, `video.py`, `audio.py`).
  Registry: `schemas/model_registry.json` (38 models) validated by
  `modules/model_registry.py`; availability only after a real probe
  (`0035_model_registry.sql`, `tools/probe_models.py`, `probe_models.yml`).
- Coverage by brief category:

| Category | State | Evidence |
| :-- | :-- | :-- |
| Image | implemented | `image.openai`, `image.gemini`, `image.bfl`, `image.ideogram(_v4)` |
| Video | implemented | `video.veo`, `kling`, `minimax`, `runway`, `luma`, `seedance`, `wan`, `bfl` |
| TTS / SFX / dub / voice change / STT | implemented | `audio.elevenlabs_*` (single vendor) |
| Upscale | implemented | `image.ideogram_upscale`, `video.runway_upscale` |
| **LLM** | **needs refactor** | no interface; `modules/gemini_client.py` is called directly by `script_engine`, `research_engine`, `topic_manager`, `fact_checker`, `comment_intelligence`, `video_critic` |
| **Music** | **missing** | `audio_mixer.py` reads local files from `MUSIC_DIR`; no generation capability or adapter |
| **Research** | **needs external provider** | `modules/providers.py::ResearchProvider` wraps Gemini recall; `research_engine.py` lines 20-24 and 70 state there is no web search or citation |

- **Two parallel provider stacks (needs refactor):** the channel pipeline uses
  `modules/video_providers.py` and `modules/image_providers.py` (chosen by
  `config.VIDEO_PROVIDER` / run params), while Studio, API and workflows use
  `modules/capabilities/`. Same vendors, two client implementations, two sets of
  error handling.
- **Model Router: missing.** `create_creative_job` (latest body in
  `0070_video_price_variants.sql`) accepts modes `exact|auto|cheap|fast|quality`
  but refuses all but `exact` with `mode_not_supported` ("Router modes need
  route_model() and failover, which are not built yet"). The designed router is
  in `docs/CREATIVE_OS_PLAN.md` §3.3 (failover never for `exact`, only to equal or
  higher tier, never above the hold). No `route_model()`, no
  `routed_model`/`fallback_from` columns.
- No silent fallback in the pipeline is enforced: `video_providers.py` header,
  `audio_mixer.verify_voice()`.

### 1.4 Specialised internal agents shown as one "Nightshift" — **partial / needs refactor**

- Internal specialists exist as modules (topic, research, script, fact-check,
  director, critic, QC, planner: `modules/agent_planner.py`, `director.py`,
  `video_critic.py`, ...). They emit `system_events` with an `agent` field
  (`modules/event_log.py`).
- The UI shows them **separately**: `/[channel]/agents/page.tsx` buckets events
  per agent (`deriveAgents`) into `AgentCard`s. Presenting one "Nightshift" voice
  is a UI refactor; no conversational agent exists (see 1.16).

### 1.5 Autonomous loop with structured data — **partial**

`main.py::run()` (1520 lines) runs: assets preflight (stage 0..0d), topic and script
(1-2, `topic_manager`, `script_engine`, `agent_planner` via `_agent_pick_topic`),
fact-check, optional storyboard review, audio (3), media (4), subtitles (5),
thumbnails (6), optional avatar (6b), compositor (7), publish gate and upload (8),
Short (9). Checkpoints: `modules/run_checkpoint.py`; IR: `video_ir.py`.

| Loop step | State | Evidence |
| :-- | :-- | :-- |
| research | partial | model recall only (1.3) |
| trends | implemented | `trend_detector.py` (`videos.list chart=mostPopular`), scheduled by `intelligence_poll.yml` |
| competitors | implemented | `competitor_monitor.py` (3 quota units per channel) |
| topic | implemented | `topic_manager.py`, `topic_recommender.py` + `content_opportunity.py` |
| script / storyboard | implemented | `script_engine.py`, `director.py`, `shot_recipes.py`, 0057/0058 |
| visuals / voice / edit | implemented | `media_fetcher.py`, `audio_mixer.py`, `scene_render.py`, `compositor.py` |
| thumbnail / title / SEO | implemented | `thumbnail_generator.py`, `title_planner.py`, `title_formulas.py`, `hook_ab.py`, `ab_testing.py` |
| validation | implemented | `video_qc.py` (ffprobe/blackdetect/silencedetect), `fact_checker.py`, `originality_engine.py`, `video_critic.py` (advisory, off by default) |
| publish gate | implemented | `publish_gate.py`, `publish_approval.py` (two-person), `upload_idempotency.py` |
| analytics | implemented | `analytics_client.py`, `revenue_tracker.py`, `intelligence_poller.py` |
| learning | implemented (human-approved) | `learning_memory.py`, `0014_learnings.sql`, `feedback_engine.py` |
| next content | partial | scheduled per channel (`daily_video.yml` hourly cron + `tools/list_channels.py`); learnings feed prompts, but not the schedule or format |

Gap: the loop runs **only for YouTube long-form channels** and as one monolithic
function; it is not a resumable job graph (resume covers script stage and repair only).

### 1.6 Channels via official OAuth APIs — **partial**

| Platform | Connect | Publish | Evidence |
| :-- | :-- | :-- | :-- |
| YouTube | implemented | implemented, always private by default | `app/api/oauth/youtube/*`, `youtube_uploader.py`, `0022_channel_tokens.sql` |
| Instagram (Reels) | implemented | implemented | `app/api/oauth/instagram/*`, `social_publish.py`, `0028_social_accounts.sql` |
| TikTok | implemented | implemented, always `SELF_ONLY` until audit | same files; header of `social_publish.py` |
| Facebook Pages | **missing** | **missing** | platform check is `('instagram','tiktok')` in 0028, `('instagram','tiktok','youtube')` in 0029 |
| X | **missing** | **missing** | none |
| Telegram channel | **missing** | **missing** | `telegram_control.py` is an operator control bot, not a publishing target |

Cross-posting goes through `publish_requests` + `publish_request_refusal` (0029),
so the gate and approvals already apply to any new platform added there.

### 1.7 Repurposing one long video into many shorts/posts — **partial**

- `modules/shorts.py::hook_window` + `render_short`: **one** vertical Short per run,
  cut from the master (no re-render).
- `modules/social_captions.py`: deterministic per-platform captions.
- `modules/remix.py` (rights gate) and `modules/remix_segments.py` (moment ranking
  and cadence) exist but **nothing imports `remix_segments`**: library only.
- Missing: N clips per master, text posts/threads/carousels from a video, scene-
  or retention-ranked clip choice.

### 1.8 AI Manager (comments, DMs, leads, Brand Brain) — **mostly missing**

- Implemented: comment fetch and classification (`comment_fetcher.py`,
  `comment_intelligence.py`, with prompt-injection handling), audience demand
  (`audience_demand.py`), one pinned comment per upload (`pinned_comment.py`,
  `commentThreads().insert`).
- Brand data that exists: Channel DNA (`0056_channel_dna.sql`: style kit, voice,
  language, format, aspect, a 200-char tone line), approved learnings (0014),
  style kits and characters (0047), style library (0065).
- **Missing:** reply drafting and sending, an inbox, DMs (Instagram messaging
  needs Meta app review; YouTube has no DM API), lead capture, a Brand Brain
  knowledge store (facts, products, FAQs, banned claims) that scripts and replies
  read.

### 1.9 Trend and competitor intelligence, no fabricated analytics — **implemented (YouTube only)**

`trend_detector.py`, `competitor_monitor.py`, `niche_rpm.py` (RPM only when revenue
is supplied), `vidiq.py` (advisory), `content_opportunity.py`, `publish_timing.py`,
`sponsorship.py`, all scheduled by `tools/run_intelligence_poll.py`. CLAUDE.md #5
("unknown is never a number") is followed in the module headers checked. Gap: no
TikTok/Instagram trend source; no external web research.

### 1.10 Unified credits and private owner margin dashboard — **implemented / partial**

- Credits: `0020_credits.sql` (`reserve_credits`, `capture_credits`,
  `release_credits`, `credit_account_lock`), refunds `0021`, lots and spend order
  `0034`, welcome grant `0027`, run billing hardening `0041`, prices in
  `credit_prices` (owner-applied `docs/sql/prices_2026_10_01.sql`).
- Margin: `0063_margin_report.sql::operator_margin_report` + `/[channel]/margin`
  (gross, before tax and Paddle fee; unknown cost is NULL with a flag).
- Not unified: REST video jobs pay from a **separate USD API balance** (0031,
  `lib/api/pricing.ts`), REST creative jobs pay from credits (0062). This split is
  the owner's decision D1 (`docs/CREATIVE_OS_PLAN.md` §6.5), not a defect.
- Margin covers creative jobs only (it reads `creative_job_costs`); channel runs
  and downloads are not in the report.

### 1.11 Subscriptions — **implemented (needs external provider live)**

`0034_plans_entitlements.sql` (plans, entitlement keys, credit lots),
`supabase/functions/paddle-webhook/index.ts` + `_shared/paddle.ts` (handles
`subscription.created/updated/activated/canceled/past_due/paused/resumed/trialing`,
`transaction.completed`), `app/api/billing/{topup,portal,refresh,settings}`,
`/pricing`. Live status depends on Paddle seller verification (`docs/PADDLE_SETUP.md`).

### 1.12 API and MCP as separate layers — **partial**

- REST: `app/api/v1/{me,balance,channels,videos,jobs,downloads,creative,accounts}`,
  keys and scopes (`0031`, `0040`, `0042`, `0062`), OpenAPI `lib/api/openapi.ts`.
- MCP: `app/api/mcp/route.ts`, `lib/api/mcp.ts`: Streamable HTTP, **API key only**,
  tools for videos, publish, downloads, balance (`docs/MCP.md`). **No creative
  tools** and **no OAuth door on site credits** (owner decision D1, plan PR 8b,
  not built).

### 1.13 Async jobs, retries, idempotency, fallback — **implemented / partial**

- `render_jobs` (0017, `tools/queue_worker.py`), `creative_jobs` (0036: claim,
  heartbeat, `max_attempts` re-queue, expiry releasing the hold), editor exports
  (0054), paid downloads (0030), workflow runs (0073), media worker (0045 status).
- Idempotency: creative jobs (`idempotency_key` in `create_creative_job`), run
  route (`IDEMPOTENCY_KEY_RE` in `app/api/agent/run/route.ts`), uploads
  (`upload_idempotency.py`), provider tasks (`provider_tasks.py`: poll instead of
  re-submit).
- Missing: provider failover (1.3); five job tables with five claim protocols and
  no single job view across them.

### 1.14 Assets — **implemented**

`0038_media_assets.sql`, folders `0049`, upload into folder `0051`, HEIC `0044`,
`modules/media_library.py` (ingest, probe caps incl. coded-size bomb fix BR-E-001),
style kits/characters `0047`, provenance in Video IR. Storage ceiling: Supabase
free tier (50 MB/object, 1 GB total), masters stay on the worker disk.

### 1.15 QC and publish gate — **implemented**

`publish_gate.py`, `video_qc.py`, `publish_approval.py`, `publish_score.py`,
`held_video.py`, cross-post refusal in `publish_request_refusal` (0029). Defaults:
`config.YOUTUBE_PRIVACY = private`, auto publish off per channel. Gate is not to be
loosened by any brief below.

### 1.16 Command interface ("Ask Nightshift...") — **partial**

- `components/CommandPalette.tsx`: navigation and hotkeys only.
- Assistant planner (1.1): typed goal parsed by rules into a priced plan.
- Missing: a conversational, model-backed command bar that can answer questions
  over the account's own data and propose (never execute unpriced) actions.

### 1.17 Analytics to action — **partial**

Advisory only: `repackage.py` flags under-performers, surfaced in
`components/intelligence/AdvisoryPanel.tsx` / `lib/advisory.ts`; learnings are
proposed then approved (0014). No one-press "do it" path (new thumbnail/title
A/B, re-cut, follow-up video) from an insight.

### 1.18 Admin control centre — **implemented**

Platform-admin pages under `/[channel]/`: `providers`, `models`, `margin`,
`security`, `audit` (0008), `errors`, `logs`, `alerts` (0010), `members`,
`organization`; worker status (0045); balances (`provider_balances.yml`).

### 1.19 Observability — **partial**

`event_log.py` -> `system_events`, `audit_log` (0008), alerts (0010), worker status
(0045), `resource_monitor.py`, `log_redaction.py`. Missing: error tracking for the
Next.js app and workers (no Sentry/OTel dependency in `package.json` or
`requirements.txt`), job latency/failure dashboards per provider, uptime checks.

### 1.20 Security — **implemented, 5 open ledger items**

`docs/security/LEDGER.md`: 0 critical, 0 high open; open: BR-S-002 (medium,
repo-scope secrets reachable from any branch, owner settings change), BR-S-003
(actions/images not pinned to digests), BR-S-004 (dev toolchain advisories),
BR-S-005 (runtime advisories: supabase-js, postcss in next), BR-S-008 (no CSP on
app pages while auth cookies are script-readable). 50+ files in `tests/security/`.

### 1.21 Tests — **implemented**

Measured in this audit: `pytest tests --ignore=tests/security`: **3110 passed,
38 skipped** (61 s). `command-center: npx vitest run`: **152 files, 2859 passed**.

### 1.22 Open-source video engines (e.g. LTX-2.x) as pluggable provider — **missing / needs infrastructure**

No code mentions LTX or any self-hosted model. The adapter contract
(`HttpAdapter.submit/poll/fetch`) and the registry's terms gates
(`terms_review_required`, `written_consent_required` in `model_registry.py`) are
the right slot. `docs/CREATIVE_OS_PLAN.md` §6.3: the AX42 host has **no GPU**.
**Owner decision** on the community licence before any production use (§5).

---

## 2. What is NOT verified

- **Production database state.** Migrations are applied by hand. Which of
  0060-0073 (and `docs/sql/prices_*.sql`) are live is unknown from the repo.
- **Deployed workers.** `deploy/docker-compose.yml` defines queue, creative and
  media workers; whether they run on the server now was not checked.
- **Real provider calls.** None were made (rule: no paid calls). Adapter shapes are
  tested against fakes; model availability is whatever the last probe recorded.
- **OAuth app status.** Google OAuth verification, Meta app review and TikTok
  audit status are outside the repo.
- **Paddle live mode** and seller verification.
- **Security lab suite** (`tests/security` against Postgres) was **not run** in this
  audit; `npx next build`, `tsc`, lint were not run (no code changed).
- **Scene repair end to end** from the Storyboard button to a `repair` job: the
  intent rows (0015), the job kind (0017) and the CLI exist; the automatic
  intent-to-job hand-off was not traced to a running process.
- **Broken:** none confirmed. Nothing was found that claims to work and does not;
  the closest is scene repair's stock substitution (1.2), which is documented in
  the module.
- **Stale documents:** `README.md`; `docs/AUTONOMY.md` (still says publishing is
  "UNCONDITIONAL", contradicted by `publish_gate.py`); `docs/ROADMAP_VIDEO_OS.md`
  (lists Video IR, QC, repair as missing; they exist).

---

## 3. Prioritised plan

Sizes: **S** <= 1 agent-day, **M** 2-3, **L** 4-6, **XL** > 6 (and split before starting).
"Brief" = a ready-to-run brief in §4.

### P0: make the core usable and safe (no new surface without these)

| # | Item | Depends on | Size | Brief |
| :-- | :-- | :-- | :-- | :-- |
| P0.1 | Model Router v1: `route_model()`, auto/cheap/fast/quality, failover never for exact | none | L | B1 |
| P0.2 | Scene regeneration v2: priced, from UI, same provider, no stock substitution | none | L | B2 |
| P0.3 | CSP + runtime/dev dependency fixes (BR-S-004/005/008) | none | M | B8 |
| P0.4 | Owner settings: BR-S-002 environment rules (no code) | owner | S | §5 |
| P0.5 | Stale docs: mark `AUTONOMY.md`, `ROADMAP_VIDEO_OS.md` superseded by this file | none | S | - |

### P1: first complete content loop for a customer

| # | Item | Depends on | Size | Brief |
| :-- | :-- | :-- | :-- | :-- |
| P1.1 | Text (LLM) provider interface, Gemini behind it | none | M | B3 |
| P1.2 | Research provider with citations; fact-check reads sources | owner picks vendor (adapter lands disabled) | M | B4 |
| P1.3 | Telegram channel + Facebook Page publishing targets | Meta review for FB live | L | B5 |
| P1.4 | Multi-clip repurposing (N shorts per master) | none | M | B6 |
| P1.5 | Comment inbox with drafted, person-approved replies | none (B3 nice-to-have) | L | B7 |
| P1.6 | Auto/Pro mode switch (Auto = router `auto`, Pro = today's pickers) | B1 | M | - |
| P1.7 | Unify pipeline b-roll/image clients onto `modules/capabilities` | B1 | L | - |
| P1.8 | MCP OAuth door on site credits + creative tools (D1, PR 8b) | Scout on MCP OAuth | L | - |

### P2: depth and differentiation

| # | Item | Depends on | Size |
| :-- | :-- | :-- | :-- |
| P2.1 | Brand Brain knowledge store read by script and replies | B7 | M |
| P2.2 | Region retake (masked image edit first, video later) | external provider with mask API, B1 | L |
| P2.3 | Music capability (generation adapter, licence-tracked) | external provider | M |
| P2.4 | One "Nightshift" presentation of agents (UI) | none | S |
| P2.5 | Analytics to action: one-press repackage A/B from advisory | none | M |
| P2.6 | Conversational "Ask Nightshift" over own data (read-only answers, priced proposals) | B3 | L |
| P2.7 | Error tracking + per-provider latency/failure board | owner picks tool | M |
| P2.8 | Margin report covers runs and downloads | none | M |
| P2.9 | Self-hosted video engine slot (e.g. LTX) as a disabled, terms-gated adapter | owner licence decision, GPU host | M (code) + infra |

### P3: scale

| # | Item | Depends on | Size |
| :-- | :-- | :-- | :-- |
| P3.1 | X publishing | owner: X API paid tier | M |
| P3.2 | Instagram DMs / lead capture | Meta advanced access | L |
| P3.3 | Loop as a resumable job graph (split `main.py::run`) | P1.7 | XL |
| P3.4 | TikTok/Instagram trend sources | official APIs/access | M |
| P3.5 | Single job view across render/creative/editor/download/workflow tables | none | M |
| P3.6 | Pin actions/images to digests (BR-S-003) | none | S |

---

## 4. Ready-to-run briefs (parallel)

Rules common to all eight (from `CLAUDE.md` and `/home/user/agent-common.md`):
own worktree and branch from `origin/main`; draft PR, never merge; no real paid
provider calls (fakes only); no secrets in code, logs or tests; never loosen the
publish gate, privacy defaults or approvals; nothing in a browser spends,
renders or publishes without the person's explicit priced press; Command Center
uses the anon key only; customer copy in en + ru + uz, no provider/model brand
names, no role words; SQL additive, `create or replace` built on the **latest**
function body (grep `supabase/migrations`, highest number wins) with a test
pinning every string literal of the replaced function; SECURITY DEFINER with
`set search_path = public, pg_temp`, explicit revoke/grant, RLS on, Verify query
at the end, security tests under `tests/security/`; unknown price is NULL, never 0.
Each brief owns its migration number; if it needs none, the number stays unused.

### B1. Model Router v1 (migration 0075)

**Goal.** Make `auto`, `cheap`, `fast`, `quality` modes work for creative jobs, as
designed in `docs/CREATIVE_OS_PLAN.md` §3.3, and record why a model was used.
`exact` keeps today's behaviour exactly: it never fails over.

**Files likely touched.** `supabase/migrations/0075_model_router.sql` (new:
`route_model(p_capability, p_params, p_mode, p_org)` pure and deterministic over
models that are `beta|ga`, verified, entitled and priced; new columns on
`creative_jobs`: `requested_model`, `mode`, `routed_model`, `fallback_from`,
`fallback_reason`; `create_creative_job` replaced from its latest body in
`0070_video_price_variants.sql`, `quote_creative_job` from 0036);
`modules/creative_worker.py` (on a retryable provider failure in a non-exact
mode, move to the next candidate of equal or higher tier whose price is within
the hold, reusing no task id across models); `command-center/lib/creative/studio.ts`,
Studio mode selector, `lib/i18n/{en,ru,uz}.ts`; tests.

**Acceptance tests.** `exact` with an unavailable model fails with the remedy and
never routes; `auto` picks the same model for the same inputs every time; `cheap`
picks the lowest quote; `quality` fails over only to an equal tier; no failover
candidate above the hold; a model with a NULL price is never a candidate; an
unverified model is never a candidate; the job row shows `routed_model` and
`fallback_reason`; the UI tells the person a different model was used and why
(customer copy keeps the no-brand-names rule); replay with the same idempotency
key returns the first job; security tests: a member cannot read another org's routing, cannot
set `routed_model` directly.

**Money/security.** Hold = quote of the most expensive candidate the person
confirmed, capture <= hold, release on failure. No new direct table writes.

### B2. Scene regeneration v2 (migration 0076)

**Goal.** "Regenerate scene" from the storyboard/video page becomes a priced,
confirmed job that rebuilds a scene with the **same kind of source** it had (AI
b-roll with the same provider, or stock), with an optional prompt edit. Remove
the silent AI-to-stock substitution in `modules/scene_repair.py`: if the original
provider is unavailable, the repair stops with the remedy, or the person
explicitly chooses stock.

**Files likely touched.** `modules/scene_repair.py`, `modules/video_providers.py`
(submit/resume through `provider_tasks.py`), `modules/run_request.py`,
`tools/queue_worker.py`, `supabase/migrations/0076_scene_regenerate.sql` (a
quote and a `request_scene_regenerate(p_video, p_scene, p_prompt, p_source,
p_max_credits, p_idem)` that reserves credits and inserts a `render_jobs` row of
kind `repair`, built on the latest render-job insert body: grep 0017..0029/0032),
`command-center/lib/sceneRepair.ts`, storyboard UI, i18n.

**Acceptance tests.** AI scene regenerated with the same provider (fake adapter);
provider unavailable -> run stops with remedy, nothing charged, no stock used;
explicit stock choice works and is recorded; price shown before the press and
held; failure refunds; duplicate press returns the same job; approvals of the
previous cut are invalidated (existing `invalidate_approvals` behaviour kept); a
published video still cannot be repaired (unchanged), and the button says why;
the gate is not evaluated as "passed" by a repair; cross-org scene id refused.

**Money/security.** Hold before dispatch, capture on success, release on failure;
nothing in the browser dispatches anything except the database call.

### B3. Text (LLM) provider interface (migration 0077, likely unused)

**Goal.** Put every LLM call behind one `TextProvider` protocol so a model can be
swapped per task without touching callers, keeping CLAUDE.md #4 (no silent
fallback) and the retry rules of `gemini_client.generate_with_retry`.

**Files likely touched.** `modules/capabilities/text.py` (new protocol + Gemini
adapter wrapping `gemini_client.py`, typed `AdapterError` codes), `modules/providers.py`,
callers `script_engine.py`, `topic_manager.py`, `fact_checker.py`,
`comment_intelligence.py`, `video_critic.py`, `structured_output.py`, `config.py`
(per-task model setting). **Do not touch `research_engine.py`** (owned by B4).

**Acceptance tests.** Every listed caller works through the interface with a fake
provider; a configured model that is unavailable raises with the remedy and no
other model is called; daily-quota vs rate-limit still distinguished (CLAUDE.md
#6); prompt-injection handling in `comment_intelligence` unchanged (existing tests
green); no key in any exception or log.

**Money/security.** Internal pipeline cost only; the cost ledger keeps recording
per call (`cost_ledger.py`).

### B4. Research provider with citations (migration 0078)

**Goal.** Add a `ResearchProvider` that returns sources (URL, title, retrieved_at,
quote) and make the script and fact-check carry them, so "researched" means
"has sources", and "no sources" is said plainly. The real vendor adapter lands
**disabled** until Scout verifies the vendor's docs and the owner provides a key.

**Files likely touched.** `modules/research_engine.py`, `modules/providers.py`
(`ResearchProvider` returns structured sources), new `modules/research_sources.py`,
`modules/fact_checker.py` (claims linked to sources; "did not run" when no
provider), `supabase/migrations/0078_research_sources.sql` (per-video sources,
RLS by org), the video page panel, i18n.

**Acceptance tests.** Fake provider -> sources stored and shown; no provider ->
UI and gate data say "no sources" / "did not run", never "verified"; a source URL
is stored but never fetched by the browser; HTML/text from sources is treated as
data (injection test like `comment_intelligence`); cross-org read refused.

**Money/security.** If the vendor is paid, a price unit in `credit_prices` with
NULL until the owner sets it; a NULL price blocks the call.

### B5. Telegram channel and Facebook Page publishing targets (migration 0079)

**Goal.** Two new cross-post targets through the existing `publish_requests` path,
so the gate, approvals and refusal reasons apply unchanged. Telegram: the
customer adds Nightshift's bot as an admin of their channel and confirms with a
one-time code; uploads via the official Bot API. Facebook Pages: official Graph
API video/Reels publishing; ships behind a config flag that stays off until
Meta app review passes.

**Files likely touched.** `supabase/migrations/0079_publish_telegram_facebook.sql`
(widen the platform checks of 0028/0029; `social_allowed_scopes`,
`store_social_account`, `publish_request_refusal` replaced from their latest
bodies), `modules/social_publish.py` (two adapters), `modules/social_captions.py`,
`app/api/oauth/facebook/*`, a Telegram connect route, `lib/server/social-*.ts`,
accounts UI, i18n, `docs/SOCIAL_SETUP.md`.

**Acceptance tests.** Gate not passed -> refused, nothing uploaded; Telegram
channel where the bot is not admin -> clear refusal; code reuse/replay refused;
size/duration limits refused with the reason; Facebook flag off -> target not
offered and the database refuses it; tokens only in Vault, never logged; master
only (no 480p fallback); duplicate request does not double-post.

**Money/security.** Uploads are free; no credits. Facebook posts default to the
most private option the API allows, matching the YouTube/TikTok rule.

### B6. Multi-clip repurposing (migration 0080)

**Goal.** From one finished master, propose up to N vertical clips ranked by scene
boundaries and measured retention when it exists (`scene_retention.py`,
`remix_segments.py` scoring reused), let the person pick, and render each as its
own `videos` row (private, held, gated) with platform captions.

**Files likely touched.** `modules/shorts.py` (multi-window), `modules/remix_segments.py`
(wire it), new `modules/repurpose.py`, `tools/queue_worker.py`,
`supabase/migrations/0080_repurpose.sql` (quote + request function, job kind,
per-clip rows; render-job insert built on its latest body), video page UI, i18n.

**Acceptance tests.** Clip windows never cross a scene mid-word; with no retention
data the ranking says "not measured" and uses scene structure only; each clip is
private and goes through the gate; price shown, held, refunded on failure; a
clip request on another org's video refused; 480p review copy never used as
source.

**Money/security.** Rendering is charged by a `credit_prices` unit (NULL until set
-> request refused); hold before the job.

### B7. Comment inbox with drafted, person-approved replies (migration 0081)

**Goal.** First "AI Manager" step: an inbox of YouTube comments (already fetched
and classified) where Nightshift drafts a reply in the channel's tone (Channel
DNA) and a person approves, edits or discards it. Approval files an intent; the
worker posts it. Nothing auto-replies.

**Files likely touched.** `modules/comment_fetcher.py`, `modules/comment_intelligence.py`,
new `modules/comment_replies.py`, `supabase/migrations/0081_comment_inbox.sql`
(comments, drafts, `approve_reply` writing an append-only intent; RLS by org),
`tools/queue_worker.py` (posts via `comments.insert`, counts quota),
`/[channel]/inbox` page, i18n.

**Acceptance tests.** Injection comment never changes the draft instructions;
spam/flagged comments get no draft; a reply is posted only after an approve
intent, once (idempotent); quota error recorded as `quota_exceeded`; viewer from
another org cannot read or approve; edited text is what is posted; delete/edit of
an intent refused.

**Money/security.** Draft generation is an internal LLM cost; if sold, priced via
`credit_prices` (NULL blocks). Uses the channel's existing `youtube.force-ssl`
scope (`lib/server/google-oauth.ts`); no new scope.

### B8. Content-Security-Policy and dependency fixes (migration 0082, unused)

**Goal.** Close BR-S-008, BR-S-004, BR-S-005: add a CSP (report-only first, then
enforced in the same PR once the report is clean in tests), bump vitest/vite and
`@supabase/supabase-js` to fixed versions, keep next on its line unless a patched
minor exists.

**Files likely touched.** `command-center/next.config.*` or `middleware.ts`
(headers), `app/layout.tsx` (nonce or hash for the inline theme script),
`app/page.tsx` JSON-LD, `package.json`/lock, `.github/workflows/frontend.yml`
(`npm audit --audit-level=high`), `docs/security/LEDGER.md`.

**Acceptance tests.** Header present on every app page with `frame-ancestors
'none'`; Paddle checkout and Supabase still load (connect-src/frame-src);
existing auth and media-route CSPs unchanged; vitest suite green after upgrade;
`npm audit --omit=dev --audit-level=high` clean; a test pins the CSP string.

**Money/security.** None; must not change auth cookie behaviour or the anon-key-only rule.

---

## 5. Owner decisions needed

| # | Decision | Why it blocks | Affects |
| :-- | :-- | :-- | :-- |
| O1 | Open-source video engines (e.g. LTX-2.x): read and accept/refuse the **community licence** (commercial use, revenue thresholds, attribution) before any production use; until then it is not enabled | no adapter may be made available without it | P2.9 |
| O2 | GPU host for self-hosted models (none today: AX42 is CPU only) and who pays | infrastructure | P2.9 |
| O3 | Research vendor and account (web search with citations) | B4 real adapter | B4 |
| O4 | Meta app review for Facebook Pages publishing and Instagram messaging; business verification | FB target stays off until approved; DMs blocked | B5, P3.2 |
| O5 | TikTok Content Posting audit (today: `SELF_ONLY` only) | public TikTok posting | 1.6 |
| O6 | X API tier (paid) or skip X | X publishing | P3.1 |
| O7 | Google OAuth verification status for `youtube.force-ssl` (comments, captions) | B7 posting at scale | B7 |
| O8 | Prices for new units: scene regenerate, repurpose clip render, research call, reply drafts (if sold), router modes (same price as the routed model?) | NULL price blocks the feature by design | B1, B2, B4, B6, B7 |
| O9 | Router policy: may `auto` pick a more expensive model than the cheapest if within the hold; which models count as the same "quality tier" | B1 behaviour | B1 |
| O10 | Music source: licensed generation vendor vs stock library, and its licence terms | P2.3 | P2.3 |
| O11 | Remotion company licence (already flagged in `docs/CREATIVE_OS_PLAN.md` §6.3) | `video-engine/` commercial use | render |
| O12 | GitHub settings for BR-S-002 (production environment main-only + reviewer; bot secrets in a restricted environment) | medium security finding, settings only | P0.4 |
| O13 | Apply pending SQL in order (see `OWNER_TODO`), then 0074 after its verification | features degrade until applied | all |
| O14 | Error-tracking tool choice (hosted vs self-hosted) | P2.7 | P2.7 |
