> **Design proposal, not implemented.** Nothing in this document is built. Line numbers refer to origin/main 085ed456 and have moved since. It is kept here unchanged below this header so the owner can decide on it.

# Design: making "Approve and publish" real (nightshift-ai-studio)

Read-only design. Based on origin/main 085ed456 (worktree /home/user/wt/design-approve, removed afterwards).
No commits, pushes, DB writes or migrations were made. "UNVERIFIED" marks anything I could not check against code or the live API.

---------------------------------------------------------------------------
## 0. What is actually true today (corrections to the audit premise)

1. The button writes one row and nothing reads it.
   - Insert: command-center/components/review/ReviewPanel.tsx:77 (`supabase.from("review_intents").insert({channel_id, video_id, action})`), button at :283-287, sheet copy at :118 (rvApproveBody: "asks the pipeline to take the video public on its next run").
   - The only code that touches `approve` intents: modules/scene_repair.py:585-594 and SQL 0076_scene_regenerate.sql:915 / 0085:241, all of which CANCEL them (`superseded_by_repair`). grep for `consumed_at` in *.py/*.yml/*.sql/*.ts finds no consumer.
   - The same is true of `regenerate` and `regenerate_script` (the other two panel buttons, ReviewPanel.tsx:292-305): filed, never consumed, and they would spend money. Out of scope here but same class of defect; they need the same Phase 0 treatment.
   - UI consequence: after one click `filed` is set (ReviewPanel.tsx:275) and page.tsx:136-148 keeps returning the unconsumed intent forever, so the panel is stuck on "Asked for: approve. The next run will act on it." and the user cannot cancel (no update/delete policy, 0004:64-72).

2. `videos.review_state='approved'` is written in ONE place: video_review.py:433 (`"approved" if auto_publish else "pending"`) at upload time. Nothing flips pending -> approved afterwards.
   - **Hidden second casualty:** the "Publish to platforms" rail refuses every cross-post with `not_approved` unless review_state='approved' (0029_publish_targets.sql:~254-257 `publish_request_refusal`; command-center/lib/publish.ts:144-150 `publishBlocker`). So for every channel with auto-publish off, the dead Approve button also blocks Instagram/TikTok/second-YouTube-channel posting. This is the strongest argument to do at least the "record the decision" half (Phase 1a) quickly.

3. Which videos does the button apply to? Two different realities (the audit mixed them):
   - **Class A – uploaded, private on YouTube, review_state=pending.** This is the normal DB-backed channel. Why: the Command Center switch writes only the `channels.auto_publish` COLUMN (ChannelCard.tsx:105-109). main.py decides upload-vs-hold from `ctx.auto_publish` = `agent_config.auto_publish`, default True (channels.py:220, :323, :581-585), so the run UPLOADS, and the column only clamps privacy to `private` (channels.py:519-531, main.py:488). Row gets review_state='pending' (video_review.py:433).
   - **Class B – held, NEVER uploaded** (no YouTube id; id is the stand-in `run-<20hex>`, held_video.py:91-97; published_at/privacy NULL, check 0016). Reached when: gate blocked (main.py:1565), upload raised (main.py:1546-1556), a scene repair's new cut (`repaired_awaiting_review`), legacy two-person hold, or `agent_config.auto_publish=false` set by hand/JSON (main.py:1594-1604). For these there is NOTHING on YouTube to flip. No code path uploads a held master without re-running the pipeline: `.upload(` is called only from main.py:292/1378 and social_publish.py:644 (grep), and `videos().update` / `privacyStatus` exist only at insert time (youtube_uploader.py:614).
   - The panel enables Approve whenever `review_state==='pending' && !autoPublish` (ReviewPanel.tsx:91, :283) - including class B and **including a gate-BLOCKED held video** (the gate line says "Blocked - it will not publish" but the button stays live). Harmless today only because nothing consumes it.
   - Auto-publish-ON channels: upload happens with the requested privacy (private unless a manual dispatch/`--privacy public`), review_state is written 'approved', the panel disables the button. Not affected.

4. Shorts: `_publish_short` (main.py ~:240-330) uploads a second private video with no review preview. Approve on the parent would not (and should not) touch it.

5. Gate verdict plumbing is weaker than the UI implies: `publish.allowed/blocked` events are emitted WITHOUT video_id (main.py:1263-1276; event_log.emit default None), and the video does not exist yet at that time. The DB check `publish_request_refusal` looks up `e.video_id = v.video_id` (0029:249-251) and the video page filters events by video_id (page.tsx:238), so for an uploaded video both usually find no event (I found no code that re-keys them). For uploaded videos the verdict is *implied* (upload only happens when `gate.allowed`, main.py:1349); for held rows it is stored in `videos.hold_detail.gate` (held_video.py:107-118). A re-check design must therefore rely on a verdict stored ON THE ROW, not on events.

6. Two-person: removed from the product (docs/security/LEDGER.md BR-L-205; command-center/tests/no-two-person-writes.test.ts forbids any app write of `require_two_person_publish` and any customer copy promising a second approver). Backend still honours the flag where already set (main.py:1293-1306, modules/publish_approval.py, 0029:260-271), and DB RLS on `publish_approvals` does NOT pin status/decided_by (BR-L-205 says: pin them with a trigger before ever reintroducing it). There is no "toggle" left in the UI.

7. Public copy that over-claims (Phase 0 list in section 5): CLAUDE.md rule 3; ReviewPanel docblock/queueHint; confirm-sheets rvApproveBody; site pages ("Watch it, then publish ... press Approve and publish. Only then does it go public." site/en.ts:288, :504); studio-page/en.ts:94 ("files a request the next run carries out"); home/rundown copy en.ts:3752, :4510, :4547, :4561 etc. in en/ru/uz.

---------------------------------------------------------------------------
## 1. Data model

### 1.1 Principle
Keep `review_intents` as the immutable "who asked" record (CLAUDE.md rule 3), and add a SEPARATE worker-owned execution row. Do not stuff claim/lease/attempt state into the immutable table. Do not reuse `publish_requests` (0029): its check constraint ties platform='youtube' to a NEW private upload on ANOTHER channel and it refuses `already_on_channel` ("this flow never changes an existing YouTube privacy", 0029 header). Copy its *patterns* (BEFORE INSERT trigger/RPC fills fields, one-live partial unique index 0029:~200-207, `claim_*` with `for update skip locked`, interrupted -> failed not retried, `*_refusal()` function used twice).

### 1.2 Approval is an RPC, not a raw insert
New `security definer` function `approve_video_publish(p_video_id text, p_cut_sha256 text, p_ack jsonb)`; EXECUTE to authenticated only; modelled on `approve_reply` (0081:753-815) and `owner_marketing_approve` (0108:607-675).
- Today's insert policy (0033:157-166: editor of the channel's org, video on that channel) is narrowed so a browser can no longer insert `action='approve'` directly; `regenerate*` unchanged. The ReviewPanel calls `supabase.rpc(...)` for approve.
- Inside, in one transaction with `for update` on the video row:
  1. caller signed in; video visible; channel derived from the VIDEO row, never from the caller (the 0033 lesson);
  2. role: see 1.6;
  3. `video_publish_refusal(video_id, cut_sha256)` (below) must return NULL;
  4. replay: if a live or applied request for (video_id, cut_sha256) exists, return it with `replay:true` (approve_reply:789-793);
  5. insert `review_intents` (action 'approve', `created_by=auth.uid()`, new column `approved_cut_sha256`), insert the request row, set `videos.review_state='approved'`, write audit.

### 1.3 Schema changes (additive; NOT written, for the migration author)
- `review_intents`: add `approved_cut_sha256 text`; `check (action <> 'approve' or approved_cut_sha256 ~ '^[0-9a-f]{64}$') NOT VALID` (old rows grandfathered). `outcome` words: `applied`, `failed:<reason>`, `refused:<reason>`, `cancelled`, `expired`, `superseded_by_repair` (existing). Only the RPC/worker (service key) set `consumed_at/outcome`, as today.
- `videos`: add `cut_sha256 text` = sha256 of the MASTER that was uploaded to YouTube and that the 480p preview was transcoded from; written in the SAME call that records the preview (video_review.py:150 `review_copy(video_path)` -> `record()` :363-452) using the existing `video_ir.file_sha256` (video_ir.py:93). Also `gate_verdict jsonb` (the stored allowed/blocks/warnings for the cut) written at upload (main.py:1378-1440 area, next to `held_video.promote`). `publish_state` keeps its meaning. Old uploads have NULL hash -> cannot be approved to public (message: "approve it in YouTube Studio"; see Phase 1b).
- New table `video_visibility_requests` (worker-owned, no API write policy; select = viewer of channel's org):
  `id bigserial`, `intent_id bigint unique not null references review_intents(id)`, `org_id`, `channel_id`, `video_id text check (~ '^[A-Za-z0-9_-]{6,64}$')`, `target_privacy text check in ('public')` (leave room for 'unlisted'), `approved_cut_sha256`, `approved_by uuid`, `approved_at`, `expires_at` (approved_at + 24h), `status check in ('queued','applying','applied','failed','refused','cancelled','expired')`, `reason text check (~ '^[a-z0-9_]{1,64}$')`, `error text (<=500, our words, never a body/token)`, `attempts`, `worker_id`, `heartbeat_at`, `started_at`, `submitting_at` (set BEFORE the YouTube write), `before_privacy`, `after_privacy`, `quota_units int`, `finished_at`, `created_at/updated_at`.
  Indexes: partial unique `(video_id) where status in ('queued','applying')` (double-click / two tabs); unique `(video_id, approved_cut_sha256) where status in ('queued','applying','applied')` (replay).
- `channels`: new per-channel opt-in `publish_on_approve boolean not null default false` (or `agent_config.publish_on_approve`), added to the admin-only control list in `channels_config_guard` / `channel_admin_controls` (0086:105-121, :154) so an editor cannot switch it on (BR-G-003 lesson). Default OFF: no channel changes behaviour by deploy alone (CLAUDE.md rule 2).

### 1.4 States and transitions
Request: `queued -> applying -> applied | failed`; `queued -> refused` (precondition failed at claim time) / `cancelled` (repair, new cut, user withdraw) / `expired` (>24h or worker down). `applying` that loses its heartbeat >30 min becomes `failed(interrupted)` exactly like claim_publish_request (0029:~330-340) - BUT see 2.4: for a visibility flip a reclaim is safe (idempotent), so unlike uploads the worker may *reconcile* instead of failing.
`videos.review_state`: `pending -> approved` at decision time (RPC) = "a human passed THIS cut" - this is what unlocks cross-posting. `approved -> pending` on any new cut (scene_repair.invalidate_approvals, 0076:913, 0085:239 - extend those to also set the request `cancelled` reason `superseded_by_repair`) and when worker finds `cut_sha256` changed. UI must NEVER say "published" until request.status='applied'; `videos.privacy` is updated by the worker on `applied` (mirror also refreshes it).
Intent: consumed (`consumed_at`, `outcome`) when the request reaches a terminal state.

### 1.5 Held vs uploaded-private
- Class A (uploaded private): eligible. Action = flip to public.
- Class B (held, never uploaded): NOT eligible in Phase 1. DB refuses `not_uploaded` (same word the cross-post rail already uses, publishBlocker lib/publish.ts:144). UI shows a truthful sentence instead of the button. A later optional Phase 2 adds "Upload as private" for a held master (needs the master on the worker disk: `resolve_master` social_publish.py:253-275; `disk_guard` keeps held runs but not forever; uses `upload_idempotency` keyed by slug/run_epoch from output/<slug>), as a SEPARATE click from going public.
- Gate-blocked (`publish_state='blocked'` or stored `gate_verdict.allowed=false`): never approvable, anywhere. ReviewPanel disables the button and the RPC returns `gate_blocked`; an approval can never override a block.

### 1.6 Who may approve (permission model)
Today: editor+ of the channel's org may file it (0018:710-713, 0033:157-166); no client role check (a viewer sees a live button that dies on RLS text).
Proposal for the PUBLIC step: admin+ (owner/admin) of the channel's organization (`is_org_member(org,'admin')`); editors can still request review but not make public. Platform admins acting on a CUSTOMER channel must be real members of that org (copy `inbox_real_member`, 0081:428, used at :779 - "public speech under the customer's name"). For the operator's own org, platform owner/admin is fine. Single approver (the product dropped two-person); if `require_two_person_publish` is already set on a channel, honour it exactly as 0029:260-271 does (refusal `awaiting_two_person`) - do not add UI for it.

### 1.7 `video_publish_refusal(p_video_id, p_cut_sha256)` (one function, called by the RPC and again by the worker, like publish_request_refusal)
Returns a reason word or NULL, in this order: `video_not_found`; `not_uploaded` (published_at null or publish_state<>'uploaded'); `gate_blocked` (stored gate_verdict.allowed is not true; NULL verdict => `gate_unknown`, never treated as pass - CLAUDE.md rule 5); `rejected`; `cut_unknown` (videos.cut_sha256 null); `cut_changed` (<> p_cut_sha256); `already_public` (videos.privacy='public'); `channel_not_connected` (channel not ACTIVE or `publish_channel_connected()` false, 0029); `not_enabled` (channel.publish_on_approve false); `awaiting_two_person` (legacy flag); `approval_expired` (worker only).

---------------------------------------------------------------------------
## 2. The consumer

### 2.1 Where it runs: the queue worker, as one more "between render jobs" step
- Add `_visibility_one()` next to `_publish_one/_download_one/_repurpose_one/_comments_one` in `Worker.run_forever` (tools/queue_worker.py:712-762), wired in `main()` (:1480-1500) with a new `VisibilityService(url, key, worker_id=..., youtube_credentials=lambda cid: youtube_publish_credentials(cid, os.environ, token_client))`. New module `modules/visibility_publish.py`, structure copied from `modules/social_publish.py` (`PublishStore.claim/refusal/update`, `process_request`, `_yt_error`).
- Why not elsewhere: GitHub Actions (daily_video.yml) only has the operator's repo secrets; a customer channel's token is in Supabase Vault and is readable only by the worker (`channel_token`, queue_worker.py:479-503; BR-G-002). A cron job in Actions would also add minutes of latency to a click. The existing `publish_requests` rail does not fit (1.1). It is not a `render_jobs` kind (no render slot needed; `run_request.plan_run` is for pipeline runs).
- If no queue worker is running, the request just sits `queued` and then `expired` after 24h; the UI shows age + "waiting for the worker" (never a fake success).

### 2.2 Authentication to the right channel
`youtube_publish_credentials(channel_id, env, token_client)` (queue_worker.py:506-525) already does exactly what is needed: `resolve_only` refuses a channel not confirmed against YouTube (CLAUDE.md rule 7), returns that channel's token in memory (Vault for customers, `CHRONOS_YT_TOKEN_<REF>` for operator channels, `YOUTUBE_TOKEN_JSON` for default), never another channel's. `YouTubeUploader.from_token_json` (youtube_uploader.py:294-322) builds the client and `_verify_channel` (:410-425) proves the token reaches the channel's YouTube id. Add a method `YouTubeUploader.set_visibility(video_id, privacy)`.
Extra guards in the worker: use the channel_id from the `videos` row (not from the request payload); after `videos.list`, require `snippet.channelId == ctx.credential.youtube_channel_id`.
Scope: `videos.update` needs `youtube`, `youtube.force-ssl` or `youtubepartner` (verified from developers.google.com/youtube/v3/docs/videos/update). Customer OAuth already asks for force-ssl (lib/server/google-oauth.ts:35-38); operator tokens issued before force-ssl was added may lack it (config.py:343-349 says they must be reconnected). Check the token's granted `scopes` from the token JSON itself (NOT `_granted_scopes()`, which reads `self.token_file` and returns an empty set for `from_token_json`, youtube_uploader.py:662-678 - note this is also a latent bug for captions on that path). Missing -> refuse `scope_missing` with "reconnect the channel".

### 2.3 The exact API calls
1. `videos.list(part="status,snippet,contentDetails,processingDetails?", id=<video_id>)` - ~1 unit (UNVERIFIED number; confirm).
   Checks: item exists (else `video_not_found_on_youtube`); `snippet.channelId` matches; `status.uploadStatus == "processed"` and no `rejectionReason` (property/values verified in the videos resource doc; "processing finished" handling UNVERIFIED in practice); title equals `videos.title`; at least one tag starting `nsrun-` (our upload marker, upload_idempotency.py MARKER_PREFIX; repo docstring says tags are returned to the owner); optionally duration ~ recorded duration. `status.privacyStatus == "public"` already -> mark `applied(reconciled)` and do not write. `"private"` -> proceed; `"unlisted"` -> treat as a human having changed it: refuse `privacy_changed` (do not override a human's choice).
2. `videos.update(part="status", body={"id": video_id, "status": <the CURRENT status object from step 1 with privacyStatus="public">})` - **50 quota units (verified, videos/update doc)**.
   Critical (verified in the same doc): update OVERWRITES every mutable property of the listed parts; fields omitted from `status` revert to defaults (privacy was the doc's own example), except `selfDeclaredMadeForKids` and `containsSyntheticMedia`, which change only when explicitly set. So GET-then-PUT the whole `status` object (keep `embeddable`, `license`, `publicStatsViewable`); do NOT send `publishAt`. Which returned status fields are read-only and must be stripped before PUT: UNVERIFIED - test on a throwaway video. Do NOT include `snippet` in `part` (it would overwrite title/description/tags).
3. Total ~51 units. Against the 10,000/day project-wide pool (CLAUDE.md ceilings; one upload is ~1600) that is cheap, but the pool is shared across ALL customers' channels, so add a daily ledger/ceiling like `inbox_quota_ledger` (0081:309-314, `record_inbox_quota`) and map quota errors to `quota_exceeded` (`_yt_error`, social_publish.py:567-585).
4. After success: `videos.list` again is optional (+1 unit) to confirm `public`; record `after_privacy`, `quota_units`; set `videos.privacy='public'`, request `applied`, intent `consumed_at/outcome='applied'`, emit event `visibility.applied` (event_log) and an audit row.
UNVERIFIED and must be tested once on a disposable channel before Phase 1b ships: (a) that a video uploaded by our OAuth project can be made public by `videos.update` at all - I recall that videos uploaded from "unverified" API projects (created after 2020-07-28) are locked private until a compliance audit passes, but the pages I could fetch do not state it (videos.insert doc says unverified projects are not restricted; the audit-guide URL returned 404). docs/GOOGLE_OAUTH_VERIFICATION.md:157-166 lists the audit/quota extension as a TODO, which suggests the project may not be audited. If the lock exists, Phase 1b is pointless until the audit passes and the button must stay a "record the decision" button. (b) status read-only fields (above). (c) `videos.list` cost.

### 2.4 Idempotency and retries
A visibility flip is naturally idempotent (setting public twice is harmless), so the dangerous failure of uploads (a duplicate) does not exist here; the dangerous one is the overwrite of other status fields and publishing a *different* cut. Hence:
- Marker: `submitting_at` set in the DB right BEFORE `videos.update` (comment_replies.py docstring: "marked submitting right BEFORE comments.insert").
- On reclaim of an `applying` row (worker died): always start from step 1 (read current state). Already public -> `applied(reconciled)`; still private -> redo steps; never a blind second write.
- Retry classes (reuse `_yt_error`): 5xx/transport/429/`rateLimitExceeded` -> requeue with backoff, max 3 attempts, inside the 24h `expires_at`; 401/`RefreshError`/missing scope -> `failed token_expired|scope_missing` (human reconnects, then presses "Try again" which re-runs the RPC with the same hash; no re-approval needed only while unexpired and hash unchanged); `quotaExceeded` -> `failed quota_exceeded` (user retries tomorrow); other 4xx -> `failed platform_error`. Never log a body or token (log_redaction already installed; keep reason words only).

### 2.5 What if the video changed after the intent / gate re-run
- The full gate (`publish_gate.evaluate`, needs `script`, `fact_results`, `ir_project`, qc report - main.py:1245-1254) cannot be re-run from the worker: those objects are not persisted. Honest design: the guarantee is "a verdict is bound to the cut it judged" =
  `videos.gate_verdict` + `videos.cut_sha256` written together at upload; approval carries the hash; the DB function and the worker both require `allowed=true` AND `cut_sha256 == approved_cut_sha256`. A different cut has no verdict -> `cut_changed`/`gate_unknown`.
- Cheap offline re-checks the worker CAN add (optional, 1b+): re-run `publish_gate._check_rights` (publish_gate.py:344) on `videos.manifest` (Video IR is stored on the row, migration 0013) so a `rights.status='blocked'` set after the render blocks the flip; re-read the channel's `publish_gate.enabled` flag only to *log* it (a channel that turned its own gate off is its choice).
- Repair / regenerate: already voids approvals (scene_repair.py:565-594, 0076:913-916, 0085:239-243). Extend those three places to cancel the `queued` request too. `scene_regenerate` is `unavailable: published` for uploaded videos, so for class A the bytes on YouTube cannot change through the pipeline; the hash still protects against a re-recorded preview or an operator re-run (resume) producing a different master under the same row.
- Blocked by gate after intent: impossible for class A by construction (blocked never uploads); a manual hold (`publish_state` changed) -> refusal `not_uploaded`.

### 2.6 Auditing
- `audit_action_allowed` (latest definition 0110_marketing_promo_custom.sql:278-310; tests/test_audit_actions.py:`latest_definition()` reads the newest one) has `video.publish_request` but no approve/visibility action. A new migration must re-create it with 0110's list VERBATIM plus: `video.approve_publish` (RPC, who/what hash/channel), `video.approve_cancel`, and (written by the service role, not held to the list but add for symmetry) `video.visibility_applied`. Otherwise the RPC's audit insert is refused (`app_audit_log_stamp`, 0087:~86-95) and `logAudit` swallows it - a silently lost audit row.
- Also emit `system_events` (`visibility.applied` / `.failed`) and let the operator bot alert on `failed` for a customer channel (modules/operator_bot/alerts.py already handles publish-class alerts).
- Audit `detail` carries ids, hashes, reason words, privacy before/after - never script text or tokens.

### 2.7 Failure messages (en/ru/uz)
Add `review.visibility.status.*` and `review.visibility.reasons.*` in lib/i18n/{en,ru,uz}.ts beside `review` (en.ts:2098-2124) following the `publish.reasons` pattern (en.ts:2211-2240, lib/publish.ts:158-175 `PUBLISH_REASONS`), and replace confirm-sheets rvApprove* (confirm-sheets/{en,ru,uz}.ts:65-67 / 53-55). Reason words: `not_uploaded, gate_blocked, gate_unknown, rejected, cut_unknown, cut_changed, already_public, privacy_changed, channel_not_connected, not_enabled, awaiting_two_person, approval_expired, scope_missing, token_expired, quota_exceeded, rate_limited, video_not_found_on_youtube, channel_mismatch, still_processing, rejected_by_youtube, platform_error, interrupted, worker_error`. Example strings:
- en `cut_changed`: "Refused: this video changed after you looked at it. Watch it again and approve the new version."
- ru `scope_missing`: "Ошибка: у канала нет права менять видимость видео. Переподключите канал на странице «Каналы»."
- uz `quota_exceeded`: "Xato: bugungi YouTube kvotasi tugadi. Ertaga qayta urinib koʻring."
- uz `approval_expired`: "Tasdiq muddati tugadi (24 soat). Videoni qayta koʻrib, yana tasdiqlang."
The UI shows: `queued` ("Waiting for the worker - asked 3 min ago"), `applying`, `applied` (link to the video), `failed/refused` + reason + "Try again".

---------------------------------------------------------------------------
## 3. Safety analysis

A wrongly published video is irreversible reputationally (screenshots, notifications to subscribers, strikes). Failure modes and guards:

| # | Failure mode | Guard |
|---|---|---|
| 1 | Double click / two tabs / retry storm | `asking` ref lock exists (ReviewPanel.tsx:105-110); add partial unique index on live request per video, unique (video, hash), RPC replay returns existing row |
| 2 | Replay of an old approval (worker down for days, then everything goes public) | `expires_at` = 24h; expired -> `expired`, never applied; intents immutable and single-use (consumed_at) |
| 3 | Stale preview vs final cut / cut changed under the reviewer | Approval binds to `videos.cut_sha256` the page showed (like marketing `content_hash`, 0108:619-648 `content_changed`); preview and hash written in the same call; DB + worker both compare; repair cancels request |
| 4 | Preview path is NOT a version marker | The preview object is overwritten in place at `{channel}/{video_id}.mp4` (video_review.py:166) - so binding to `preview_path` (as the question suggested) would not work; use the hash |
| 5 | Gate block overridden by an approval | Stored `gate_verdict` required allowed; blocked/held-never-uploaded are refused in DB (not just UI); gate is evaluated BEFORE the approval is accepted and again at apply; NULL verdict is "unknown", never a pass (rule 5) |
| 6 | Wrong channel / wrong token | Channel from the video row; `resolve_only` + `channel_token`; `snippet.channelId == channel.youtube_channel_id`; token never from env for customer orgs (BR-G-002) |
| 7 | Someone flips a video the human did not see (video id swapped, other org's video) | RPC derives org from the row and checks membership like 0033; request carries video_id + hash only |
| 8 | Clobbering other status fields on update | GET-then-PUT whole `status`; only `status` part (verified overwrite semantics) |
| 9 | Overriding a human's later change on YouTube | If YouTube says unlisted/public already: reconcile or refuse `privacy_changed`; never force |
| 10 | Copyright/Content ID claim or YouTube-side rejection | Check `uploadStatus=processed` and no `rejectionReason`; claims are NOT visible via the Data API (UNVERIFIED) -> cannot be guarded; keep the human check on YouTube Studio's "Checks" tab in the sheet text |
| 11 | AI-media / synthetic-content labelling | The uploader never sets `status.containsSyntheticMedia` (grep: no hit) and hardcodes `selfDeclaredMadeForKids:false` (youtube_uploader.py:615). Nightshift output is largely AI voice/imagery. Whether YouTube's disclosure rule applies per video is a policy question - UNVERIFIED. ToS already puts labelling on the customer (legal-docs/en.ts:283). Proposal: approve sheet has a required acknowledgement ("I checked rights and labelled altered/synthetic content where required") stored in `p_ack` and the audit row; optional per-channel default for `containsSyntheticMedia` is an owner decision (field exists in videos.insert/update, verified; meaning of a wrong value is not) |
| 12 | Consent on customer channels | Public speech under the customer's name: only real members of the customer org (admin+) approve; platform admins cannot approve for customers (inbox pattern); per-channel `publish_on_approve` is admin-only and default off; operator never flips a customer's video automatically |
| 13 | Quota exhaustion starving uploads | Flip is ~51 units, ledger + daily ceiling, 24h expiry |
| 14 | Google verification | Using `videos.update` must be disclosed: update legal-docs/{en,ru,uz}.ts (docs/GOOGLE_OAUTH_VERIFICATION.md:162-166; tests/legal-docs.test.ts checks scopes) and the OAuth reviewer demo (currently shows "private video in Studio", :145-146) |
| 15 | Rule 2 / rule 3 of CLAUDE.md | Rule 3 holds (browser writes an RPC row, worker acts). Rule 2 ("the bot has never published anything publicly on its own", "nothing may make the bot publish more autonomously") is the owner's: a human-approved flip is not autonomy, but it IS the first time the system itself makes a video public. It needs an explicit amendment of rule 2/3 text by the owner, and the per-channel opt-in default-off |
| 16 | Shorts child | Not touched; stays private. Decide separately |
| 17 | Worker cannot reach YouTube / mis-sequencing | Everything fails closed: any doubt -> `refused/failed`, video stays private (the safe state) |

Note the asymmetry that makes this design comparatively safe: every failure leaves the video PRIVATE, which is the safe state, so the whole machine can be conservative and retry-able. The only irreversible step is the single `videos.update` that happens after hash, gate, role, expiry, channel and current-privacy checks.

---------------------------------------------------------------------------
## 4. Phased plan

### Phase 0 - truthful copy (days; no behaviour change; do first)
Goal: nothing claims more than the code does while Phase 1 is decided.
- ReviewPanel.tsx: the label `review.approve` ("Approve and publish") promises more than the code does. Honest minimum: relabel it to what is recorded (e.g. "Record my approval") and (a) disable Approve unless the video is class A, not blocked, and the user is admin+; (b) `review.queueHint`/`filed` text: "Your approval is recorded. Nothing is published automatically yet - make the video public in YouTube Studio." (en.ts:2117-2123, ru.ts:2105-2110, uz.ts equivalent); (c) same for `regenerate*` ("recorded; not carried out yet" - they are dead too); (d) rewrite rvApprove*/rvRegen*/rvScript* in confirm-sheets/{en,ru,uz}.ts:65-71; (e) fix the docblock claim at ReviewPanel.tsx:11-18.
- Fix the stuck state: show pending intent age and say it is not being processed.
- Public pages (all three languages): site/*.ts:288, :504 ("Only then does it go public"), :35, :62, :232, :271-274, :599; studio-page/*.ts:94 (+ :96-98, :139, :157); en.ts:3645-3660, :3752, :4510, :4547, :4561, :4601, :5206-5249; llms.txt / docs pages that repeat it. Truthful replacement: "Videos upload to YouTube as private. Nothing goes public until you make it public." Note tests (no-two-person-writes.test.ts) scan these files for forbidden phrases; keep them passing.
- CLAUDE.md rule 3: change "the next pipeline run reads it and acts" to what is true ("... for scene repair, which consumes `regenerate_scene` intents; `approve` is recorded only until the visibility worker exists").
- Add a test pinning "no copy says the button publishes" until Phase 1 flips it.

### Phase 1a - make the decision real, no YouTube write (small; unlocks cross-posting)
- Migration: `approve_video_publish` RPC variant that does steps 1-5 of 1.2 WITHOUT creating a visibility request; sets `review_state='approved'`, binds `cut_sha256`; narrows direct insert policy; audit action. Python: write `videos.cut_sha256` + `gate_verdict` at upload/hold (video_review.py record(), held_video.record_held/promote, main.py). `scene_repair.invalidate_approvals` and 0076/0085 already reset review_state.
- UI: button calls the RPC; panel shows "Approved by X on <date>. Still private on YouTube - make it public in Studio" + link. Cross-post rail works for non-auto channels.
- Value even if the owner never allows the bot to flip privacy. Effort ~2-3 days.

### Phase 1b - the visibility worker (behind a per-channel opt-in)
- Migration: `video_visibility_requests`, `publish_on_approve` (+ guard list), claim/finish RPCs, `video_publish_refusal`, quota ledger, `audit_action_allowed` re-creation.
- Python: `modules/visibility_publish.py`, `YouTubeUploader.set_visibility`, queue_worker.py wiring (:712-762, :1480-1500), `repair` hooks (scene_repair.py:565-594).
- UI: status chip + reasons + try again + sheet (ack checkbox, shows channel, title, hash short, gate line).
- Pre-req: the owner's one-time live test of 2.3 (a)(b)(c) on a disposable channel; legal-docs update.
- Effort: ~5-8 engineer-days incl. tests and review (Forge + Lens + Probe + Breach per CLAUDE.md pipeline), more if the audit lock exists.

### Phase 2 (optional, later) - class B
"Upload held master as private" via worker (master on disk required; refuses `master_not_available` like social_publish.py:~675), then the normal Approve. Never upload-and-public in one click.

### Files to change (summary)
- Python: main.py (gate_verdict/cut hash at ~1378-1440, 1546-1604 hold paths), modules/video_review.py (:363-452), modules/held_video.py, modules/scene_repair.py (:565-594), modules/youtube_uploader.py (new method; fix scope read), modules/visibility_publish.py (new), tools/queue_worker.py (:712-762, :1480-1500), modules/event_log.py (events), modules/operator_bot/alerts.py (optional).
- SQL (new migrations, numbering after 0110): RPC, table, refusal fn, claim/finish fns, `channels` flag + guard (0086 lists), audit list (0110 verbatim + new), cancel hooks in scene regen functions (0076/0085 replacements).
- TS: components/review/ReviewPanel.tsx (:77, :91, :105-145, :275-310), app/(app)/[channel]/videos/[id]/page.tsx (:136-148 query), lib/types.ts (:73-84, VideoRow cut_sha256), lib/publish.ts, lib/i18n/{en,ru,uz}.ts + confirm-sheets + site + studio-page, lib/legal-docs/{en,ru,uz}.ts, a new tiny `lib/visibility.ts`.
- Docs: CLAUDE.md rules 2-3, docs/GOOGLE_OAUTH_VERIFICATION.md, docs/security/LEDGER.md entry.

### Test plan
- Python (unittest): refusal function matrix (each reason word); worker with fake YouTube service: private->public happy path, already public (reconcile), unlisted (refuse `privacy_changed`), wrong channelId, missing scope, quota, 5xx requeue then success, crash after `submitting_at` then reclaim, expired, hash mismatch, repair-cancel; assert the PUT body contains the original `embeddable/license/publicStatsViewable`; assert `videos.update` is never called with `snippet` part; assert no token/body in logs/errors.
- tests/security (Breach lab only): editor cannot approve public; org B cannot approve org A's video; platform admin cannot approve for customer channel; direct insert of `action='approve'` refused; forged `approved_cut_sha256`; cannot update/delete request or intent; viewer cannot see other org's requests; channel flag not writable by editor; audit action present; replays.
- tests/test_audit_actions.py picks up the new actions; vitest: ReviewPanel disabled states (blocked, class B, viewer), copy never says "published" before `applied`, i18n parity en/ru/uz, no forbidden phrases; Playwright/Probe: double click, refresh mid-job, expired approval, mobile width.
- Live (owner-run, disposable channel): the three UNVERIFIED items in 2.3.

---------------------------------------------------------------------------
## 5. Recommendation and owner decisions

**Recommendation:** do Phase 0 now (it removes the false promise today, including on the public /studio and marketing pages). Then Phase 1a (real, safe, small: the decision is recorded, bound to the exact cut, auditable, and it unblocks cross-posting). Treat Phase 1b (bot flips private -> public) as a separate, opt-in feature that ships only after the owner approves the points below and the live test passes. Do not ship a version where the button silently does nothing, and do not auto-publish held (never uploaded) videos.

### Egasi (owner) hal qiladigan qarorlar - oddiy tilda
1. **Hozir tugma nima qilsin?** Yoki (a) faqat "tasdiqladim" deb yozib qo'ysin, videoni YouTube Studio'da o'zim ommaviy qilaman; yoki (b) tasdiqdan keyin dastur o'zi videoni ommaviy qilsin. Men avval (a), keyin (b) ni tavsiya qilaman.
2. **Qoida 2 va 3 ni o'zgartirasizmi?** "Bot hech qachon o'zi ommaviy qilmagan" degan qoida (b) variantida o'zgaradi. Siz ruxsat bermasangiz, (b) qilinmaydi.
3. **Kim tasdiqlay oladi?** Faqat admin/egasi (tavsiya), yoki editor ham? Mijoz kanalida faqat mijozning o'z jamoasi tasdiqlaydi, siz (platforma admini) mijoz nomidan tasdiqlamaysiz - rozimisiz?
4. **Ikkinchi odam tasdig'i** (two-person) mahsulotdan olib tashlangan. Qaytarmaymiz - to'g'rimi? (Qaytarsak, avval ma'lumotlar bazasida soxtalashtirishdan himoya kerak.)
5. **Har bir kanalda alohida yoqish**: "tasdiqdan keyin avtomatik ommaviy" sozlamasi sukut bo'yicha O'CHIQ, faqat admin yoqadi - rozimisiz?
6. **Tasdiq muddati**: 24 soat o'tsa tasdiq kuchini yo'qotadi (qayta tasdiqlash kerak). 24 soat mosmi, yoki qisqaroq?
7. **Video o'zgarsa** (qayta render, sahna ta'miri) eski tasdiq bekor bo'ladi - shuni tasdiqlaysizmi? (tavsiya: ha, doim)
8. **Tekshiruvdan o'tmagan (blocked) video** hech qachon tasdiq bilan chiqmaydi - to'g'rimi? (tavsiya: ha, hech qachon)
9. **YouTube'ga hali yuklanmagan (held) videolar**: tugma ularda ishlamasin, keyinchalik "avval yopiq yukla" tugmasini qo'shamiz - mos?
10. **AI/sun'iy kontent belgisi**: YouTube'da "o'zgartirilgan yoki sun'iy kontent" belgisi kerakmi? Hozir dastur uni hech qachon qo'ymaydi. Tasdiq oynasiga "huquqlar va belgilarni tekshirdim" katakchasini qo'shamizmi? Huquqiy javobni siz yoki yurist berishi kerak.
11. **YouTube API auditi**: loyihangiz auditdan o'tganmi? O'tmagan bo'lsa, YouTube API orqali yuklangan videolar yopiq holda qulflanishi mumkin (men buni tekshira olmadim). Bitta sinov kanalida "yopiq -> ommaviy" ni qo'lda sinab ko'rish kerak - sinab ko'ra olasizmi?
12. **Shorts**: asosiy video ommaviy bo'lganda unga bog'liq Short ham ommaviy bo'lsinmi? (hozircha: yo'q, alohida)
13. **Boshqa ikki tugma** ("Render it again", "New script, new video") ham hech narsa qilmaydi va pul sarflaydi. Hozir o'chirib qo'yamizmi yoki nusxasini ham yozamizmi? (tavsiya: Phase 0 da o'chirish/ochiq yozish)
14. **Google tekshiruvi (OAuth verification) va maxfiylik hujjati** `videos.update` ni ishlatishni yozishi kerak - buni yangilashga ruxsat.
