# Proposal: autonomy ramp-up ladder

Status: **DRAFT, design only.** Docs only: no code, no migration, nothing applied, no money.
Written for the owner to read on a phone. Summary first, details after.
Basis: `main` at `da00b7d` (PR #551), plus the unmerged draft PR #543 (branch head `6599d4b`:
migration 0116, `docs/APPROVE_PUBLISH_1B.md`, the rule 2/3 patch). Nothing here was run against
production. Chronos facts (ACTIVE, 22:00 UTC, `channels.auto_publish` off, no `auto_publish` key in `agent_config`, 0 videos) are as the coordinator
reported them from the live row; I did not read it myself.

**Correction (second commit).** The first version of this document treated `auto_publish` as one switch and concluded Chronos was at "hold" (L0). That was wrong: there are two different switches (section 1.1). Chronos is at L1 today: tonight's 22:00 UTC run uploads a gate-passing video as private. Sections 0, 1, 3, 4, 7 and the summary were rewritten; the rest only where it named the switch.

---

## Summary

1. **Four levels per channel.** L0 hold (an allowed video is kept on disk, not uploaded). L1 private upload, owner reviews (**Chronos today**). L2 publish when approved (0116, not released). L3 auto-publish after the gate plus a hold-back window (does not exist; needs its own rule amendment).
2. **Up is always a person.** An admin moves a channel up, one rung at a time, with a typed word. The system only measures and *recommends* (an alert). It never promotes.
3. **Down is automatic.** WARN (alert, promotion frozen), DEMOTE (one rung), HALT (level 0 and the schedule paused). Unknown data never promotes and never demotes.
4. **Facts found in the code that shape the design** (each marked VERIFIED with file:line in section 0). (a) There are **two** `auto_publish` switches: the `agent_config` key decides *upload or hold*; the Channels-page column only *clamps privacy to private* and never stops an upload. No scheduled path can make a video public today. (b) Nothing records an owner *rejection*, and nothing reads YouTube after upload (forced-private, removed, rejected are invisible; `videos.privacy` stores what we asked for). (c) The 0116 worker does not read `NIGHTSHIFT_PIPELINE_PAUSED`. (d) Events reach the database only through the 20:00 UTC poll.
5. **Data model.** L0 to L2 need no new column (derived from the `agent_config` key and `publish_on_approve`; the Channels-page column is a separate clamp, see 1.1). L3 needs one admin-only column plus a service-only demote function (shapes in section 3, no migration written).
6. **Chronos.** Already at L1: videos 1 to 7 (you choose 5 to 10) are private uploads reviewed with a 10-point checklist, starting with tonight's run. The report then says READY or NOT READY cell by cell. Going public *automatically* is not possible before phases 2 to 4.
7. **Be honest about evidence.** Seven clean videos only rule out a bad-video rate above about 35% (95% confidence). The ladder limits the blast radius and forces a human look; it does not prove quality.
8. **Smallest first PR:** a read-only evaluator and a report CLI. No migration, no alerts, no publish code. It gives Chronos its checklist the same week.
9. **16 open questions** for you are in section 7. Items I could not verify are in section 0.

---

## 0. What is verified and what is not

Re-checked against `main` at `da00b7d` after the correction. **VERIFIED** = I read the lines named this session. **UNVERIFIED** = not read, or cannot be read from the repository.

**The two switches (the point the first version got wrong)**

- VERIFIED. `agent_config.auto_publish` (upload or hold): `modules/channels.py:221` (default True), parsed at `:337` (only an explicit false turns it off), read as `ctx.auto_publish` at `:599-603` and `main.py:1381`. An allowed video uploads only if `gate.allowed and auto_publish` (`main.py:1448`); if the key is false the video is held on disk with a held row and a review copy (`main.py:1709-1718`). No Command Center control writes this key (grep of `command-center/app`, `lib`, `components`: none), so it is set in the channel's config blob.
- VERIFIED. Column `channels.auto_publish` (migration 0004, default false), the Channels-page switch: written by `ChannelCard.tsx:108`; read as `ctx.ui_auto_publish` (`channels.py:521-534`, `:664`); `effective_privacy` (`channels.py:537-548`) is applied at `main.py:437-446` and `:559`: not plainly true clamps privacy to `private`; true or absent passes the requested privacy through. **It never stops the upload.** The same column is also read by `VideoReview.fetch_auto_publish` (`video_review.py:302-327`), which makes the stored `review_state` 'approved' instead of 'pending' (`video_review.py:453`) with the person fields cleared right after (`:459`, `NO_APPROVAL` at `:69`): it is not a person's approval.
- VERIFIED. Scheduled runs pin `private`: `daily_video.yml:458` (`inputs.privacy || 'private'`) feeds `--privacy` at `:603`. The manual dispatch menu offers `public` (`daily_video.yml:33`); with the column false it is clamped to private.
- UNVERIFIED by me (reported by the coordinator from the live row): Chronos has `channels.auto_publish = false`, no `auto_publish` key in `agent_config` (so the agent default True applies), schedule 22:00 UTC enabled, 0 videos.

**Other findings**

- VERIFIED. Approve is refused for a held, blocked or never-uploaded run: `0112_approve_video_publish.sql:38`. It records the decision and does not change privacy.
- VERIFIED. YouTube is never read after upload: `youtube_uploader.py:466` returns only `response["id"]`; `main.py:1514`, `:1531`, `:1544` store and emit the *requested* `privacy` (`state_store.py:309-318` persists it); no module outside the uploader's request body (`youtube_uploader.py:643`) mentions `privacyStatus`.
- VERIFIED. No owner rejection is recorded: `review_state` allows `rejected` (`0004_review.sql:38`) and three functions read it (`0029:254`, `0080:497`, `0112:180`), but a grep of `supabase/migrations`, `modules`, `tools`, `main.py`, `command-center/app` and `lib` finds no writer; `review_intents.action` has no reject (`0015_scene_repair_intents.sql:31`).
- VERIFIED. The service key passes the 0086 guard (`0086_channel_config_lock.sql:161`, `current_user not in ('authenticated','anon')`); the 0116 guard refuses it too (`0116_visibility_requests.sql:109` on #543, head `6599d4b`).
- VERIFIED. Events are written to the local store (`event_log.py:296-330`) and reach Supabase only through `supabase_sync.mirror_from_store` (`supabase_sync.py:400`), whose only caller is `tools/run_intelligence_poll.py:548` (called at `:633`), cron `0 20 * * *` (`intelligence_poll.yml:11`). A 22:00 UTC run's events arrive about 22 hours later. `videos` rows are written when the run ends (`main.py` review/held recording after upload).
- VERIFIED. The global pause is read in one place: `tools/list_channels.py:66,77` (called from the workflow's resolve step, `daily_video.yml:141`). A grep of all `.py`, `.yml` and `.example` files finds no other reader. `tools/queue_worker.py` on main has only the storyboard exit code named PAUSED (`:136`, `:1304`); `tools/queue_worker.py` and `modules/visibility_publish.py` on #543 have none. Whether the worker's environment even holds the variable is UNVERIFIED.
- VERIFIED. `CLAUDE.md` on `main` has the *unamended* rules 2 and 3. The "named exception" for publish-when-approved exists only as the patch `docs/proposals/claude-md-rules-2-3-phase-1b.patch` in #543. This proposal assumes it is applied before L2 is used.

**UNVERIFIED** (needs Scout or the owner):

- That `videos.insert` returns `status.privacyStatus` in its response (I believe so).
- The `videos.list part=status` fields (`uploadStatus`, `failureReason`, `rejectionReason`) and their values: from memory of the API docs.
- Whether an unaudited API project is forced to private. The #543 doc records two conflicting official statements; the live test decides.
- That strikes are invisible to the Data API (I believe so). Treated as owner-attested only.
- Whether operator and customer channels share one OAuth project (matters for the project-wide halt in D4).
- That Chronos is channel id `default` (`tools/list_channels.py` calls the legacy default "Chronos").
- How long YouTube takes to finish processing and automated claim checks (sets the hold-back length).
- Quota cost of thumbnails, comments and playlist calls (not in the repo's ceilings table).
- Who writes `channels.agent_config` with the service key (matters for hardening H1).

---

## 1. The ladder

### 1.1 Levels in terms of the switches that already exist

Three inputs (names as in section 0): **U** = `agent_config.auto_publish` (upload or hold; absent means upload), **C** = column `channels.auto_publish` (the Channels-page switch; only clamps privacy), **A** = `channels.publish_on_approve` (0116). A fourth, **G** = `publish_after_gate`, is new (L3).

| U | C | A | What a scheduled run does | Level |
| :-- | :-- | :-- | :-- | :-- |
| hold | any | any | renders, gates, holds on disk, no upload | L0 |
| upload | off | off | uploads **private** (clamped; the schedule asks private anyway) | **L1 (Chronos today)** |
| upload | on | off | uploads private (the schedule asks private); a manual dispatch with `public` would go public; stored `review_state` starts 'approved' without a person | L1, "open" |
| upload | any | on | as above; a person's Approve queues a flip within 24 h | L2 |
| upload | any | on + G | after the gate, a hold-back and a last check, the same worker flips with no tap | L3 |

The level is **derived**, never stored: a function of U, A and G. C is not a level; it is the lever that lets a *manual run* ask for public, so the evaluator reports it as a note (open question 16) and L2/L3 do not need it, because the worker, not the run, changes privacy. A dormant combination (for example A on while U is hold) reads as the lowest consistent level. One source of truth, no drift.

What each level means for you:

- **L0 Hold.** Gate-passing videos stay on disk with a 480p review copy in the app. Approve is refused (not uploaded).
- **L1 Private.** Upload private; the owner reviews in Studio and the app; Approve is a record only and leaves privacy alone; making it public is a human act in Studio.
- **L2 Approve.** "Approve and publish" queues one request; a worker flips and reads back.
- **L3 Auto.** As L2 without the tap.

L3 reuses the 0116 flip path on purpose. The #543 rule patch says `modules/visibility_publish.py` is the only code that may change an existing video's privacy. A direct `privacy=public` insert would be a second path, with no read-back, no quota ledger and no reconcile logic. The schedule keeps pinning `private` forever.

### 1.2 Who moves a channel

| Move | Who | How |
| :-- | :-- | :-- |
| Up (L0 to L1) | admin, human | set `agent_config.auto_publish` to true (a 0086 admin-only control; no dashboard control exists for this key, so it is a config edit) |
| Up (L1 to L2) | admin, human, real member | 0116 `set_channel_publish_on_approve` |
| Up (L2 to L3) | admin, human, real member | new `set_channel_publish_after_gate` (section 3) |
| Recommend | system | alert + report. No write to `channels` |
| Down / kill | system or human | service-only demote function; humans use the same switches off |

Rules that keep this inside rules 2 and 3:

- One rung at a time. No jump from L1 to L3.
- The system holds no permission to raise anything. It calls no promote function (the service key is refused by the guard triggers).
- A demotion is *sticky*: a person must switch the level on again, after reading the reason. Switching on is the promotion act and needs the same evidence screen.
- Thresholds live in code constants, changed by reviewed PR, never by a database row an editor can write.

### 1.3 Evidence we already have (and its limits)

| Metric | Source | Arrives |
| :-- | :-- | :-- |
| videos produced | `videos` row, `publish_state` | at run end |
| gate pass / hold / block | `videos.gate_verdict` (0112, NULL = unknown), `hold_detail.gate.blocks` | at run end |
| QC scene blocks | gate blocks named `video_qc_*` (PR #551) | at run end |
| upload failures | `hold_detail.cause = 'upload_failed'` | at run end |
| failed runs (topic, render, spend stop) | events `agent.failed` stage topic, `render.failed`, `budget.exceeded`; failed `daily_video.yml` jobs | events up to ~22 h; workflow minutes |
| AI-disclosure coverage | event `video.ai_disclosure` per video | up to ~22 h |
| owner review | `review_state`, `decided_at`, `approved_cut_sha256` = `cut_sha256`; `review_intents` (`regenerate_scene` count) | immediate |
| cost | `video_costs`; known only if every unit is priced | at run end |
| publish truth | 0116 `video_visibility_requests` (`applied`, `refused`, `failed`, `expired`, `after_privacy`) | after 0116 |
| YouTube-side state | **not read anywhere today** | never |
| strikes | **invisible to the API** | owner only |
| owner rejections | **not recorded** | never |

Consequences, written down so they are not forgotten:

- Anything that can only come from events is a *slow* signal. Decisions that must be fresh (the L3 last check) may use only `videos` rows, the 0116 tables, and a fresh YouTube read.
- A cell that cannot be measured is **unknown**. An unknown cell never counts as met and never counts as a failure. A report that says READY must have zero unknown cells in its required set.
- "Not approved" and "rejected" cannot be told apart today. The report shows only "not approved". Section 6, phase 2c proposes a reject record.

### 1.4 Entry and exit conditions

All numbers are **proposals**, not measurements (Chronos has no history). They sit in one constants block.
`N1 = 7` (you may set 5 to 10), `N2 = 10`. "Window" means the last N scheduled long-form videos since the channel's most recent ladder event (promotion or demotion). Manual dispatches and Shorts do not count.

**L0 to L1: recommend when ALL hold** (Chronos skips this step: it is already at L1; the same list is its preflight, section 4)

1. Channel is ACTIVE and verified against YouTube (rule 7).
2. The scheduled readiness check is green and the token has the scopes the run needs.
3. `spend_ceiling_usd` is set, and the smoke video's cost is fully priced (no partial total).
4. `publish_gate` is not weakened (`enabled` and every `block_on_*` not turned off).
5. At least 1 produced video with `gate_verdict.allowed` true and zero `video_qc_*` blocks.
6. The owner has watched that video's review copy in the app (an Approve is impossible at L0, so this one is an **owner statement**, shown as "not measured").

**L1 to L2: recommend when ALL hold** (window `N1`)

1. Produced videos in the window = `N1`; every one has a known gate verdict.
2. At most 1 gate block; zero failed runs; zero upload failures.
3. Every uploaded video is approved, except at most 1.
4. Zero `video_qc_*` blocks in the last 5; at most 2 QC warnings in the window.
5. AI-disclosure decision recorded for 100% of uploaded videos.
6. Window fully priced; zero spend stops.
7. Every uploaded video read back from YouTube as private, processed, not rejected, not deleted (needs phase 2 reader; until then this cell is unknown, so the recommendation cannot appear).
8. No demotion in the last 14 days.
9. Promotion screen carries the owner statement "Studio shows no strike or limit" (typed word + acknowledgement, written to the audit row).
10. Project-level: the 0116 live test answered "an unaudited project can make a video public" (owner-recorded fact, once).

**L2 to L3: recommend when ALL hold** (window `N2`, with at least 5 flips)

1. Conditions 1 to 8 above, rescaled to 10 (gate allowed at least 9 of 10; zero QC blocks in all 10).
2. At least 5 requests `applied` with read-back public; zero `platform_kept_private`; zero `status_unreadable`; at most 1 `expired` approval.
3. At least 3 published videos older than 48 h with no policy signal (removed, rejected, made private or unlisted, age-restricted) when read again.
4. Zero ladder events in the last 30 days.
5. `require_two_person_publish` is off, and the gate is not weakened.
6. Rule amendment for L3 applied and the worker's policy lock on (section 3).

**Exit (down)** is section 2. There is no timer-based promotion and no "after N days" shortcut.

### 1.5 What the window can and cannot tell you

If the true bad-video rate were 10%, seven clean videos happen about 48% of the time (0.9^7), ten about 35%. With zero bad in 7, the 95% upper bound on the rate is about 35%; in 10, about 26% (exact binomial, 0.05^(1/n)). So the window is a *minimum bar*, not proof. What actually limits harm at L2 and L3: the gate, the hold-back, the last check, and fast automatic demotion. Strikes arrive days late; the 48 h settling rule (L2 to L3, item 3) is there for that.

---

## 2. Demotion and kill

### 2.1 Three actions

| Action | Effect |
| :-- | :-- |
| WARN | alert; promotion frozen for 14 days; nothing else changes |
| DEMOTE | lower one rung (L3 to L2, L2 to L1). At L1 or L0 it behaves as WARN. (L1 to L0 is available only to HALT, which sets the `agent_config` key to hold) |
| HALT | level 0 **and** the channel's schedule paused (`status` PAUSED), so spend stops too |

### 2.2 Triggers

Counts are over started runs, not calendar days: a global pause leaves no gaps that look like failures (silence is the dead-man alert's job, not this one's).

| # | Trigger | Evidence | Action |
| :-- | :-- | :-- | :-- |
| D1 | gate block spike | 2 of last 5 videos blocked; 3 of 5 or 3 in a row | DEMOTE; HALT |
| D2 | QC scene block | one `video_qc_*` block; two in a row | WARN; HALT (the render is suspect) |
| D3 | operational failures (run failed, topic selection failed, upload failed, spend stop) | 2 started runs in a row; 3 in a row | DEMOTE; HALT |
| D4 | platform signal | `platform_kept_private`, observed privacy not what was asked, `uploadStatus` failed/rejected, `rejectionReason`, video removed by YouTube, token revoked or `scope_missing` at flip time | HALT. Forced-private is project-wide: all channels on that OAuth project drop to L1 at most |
| D5 | owner-known strike | owner only (invisible to us) | the owner pauses or switches off; ladder shows it as a manual event |
| D6 | YouTube quota exhausted | one day; two days in a row | WARN; DEMOTE |
| D7 | monthly channel spend ceiling hit | `budget.exceeded` | WARN + freeze (the run already refuses to spend). The operator's daily cap is WARN only |
| D8 | disclosure gap | uploaded video with no recorded AI-disclosure decision | DEMOTE at L2 or L3; WARN below |
| D9 | owner reversal | a published video later set private/unlisted or deleted by a person within 7 days | DEMOTE to L1 |
| D10 | gate weakened | `publish_gate.enabled` or any `block_on_*` turned off at L2 or L3 | DEMOTE to L1 at once |
| D11 | unreadable source | Supabase or YouTube read fails | no change. Blocks promotion. Existing `health` "blind" alert |

Notes:

- D1 and D2 overlap by design: content blocks mean the niche or DNA is producing unpublishable material; technical blocks mean the pipeline is broken. Both stop publishing power; only repeated technical blocks stop spending.
- An unaudited project that silently keeps videos private must **never** be counted as a successful publish. A publish counts only when a read-back saw `public` (0116 `applied`). `platform_kept_private` is a failure of the *project*, not of the channel.
- "Unknown is not a no" cuts both ways. A read that fails is not evidence of failure (D11), so an outage cannot demote the fleet.

### 2.3 What the owner sees (existing operator bot kinds)

- Demotion, halt, quota, failures: kind `pipeline` (warn). Text is ids, levels and one closed word, never a title: `Chronos (default): L2 to L1. Reason: gate_blocks 2 of 5. Publishing power is off until an admin turns it on.`
- Recommendation: kind `approval` (info), once per channel per step per UTC day: `Chronos is ready for L2 (7 of 7 clean, 0 unknown). Nothing changed. An admin must switch it on.` This stretches `approval` ("a new pending publish approval"); it is the nearest existing "waits for a person" kind.
- Blind sources: kind `health`, already exists.
- A "recovered" note follows once when the cause clears (existing behaviour).
- Daily digest and `/channels` gain the level word. E-mail copy follows `OWNER_EMAIL_KINDS`.
- Gap: all existing kinds that suit a HALT are warn. Quiet hours hold warn alerts. A strike-class halt arguably deserves `critical`; that needs a new kind (open question 5).

### 2.4 Recovery

HALT and DEMOTE are undone only by a person: read the reason, fix the cause, switch up again (one rung, same promotion screen, audit row). Unpausing a halted channel is the same act. The evidence window restarts at the demotion, so the channel earns its way back with fresh videos.

---

## 3. Interaction with the existing controls, and the data model

### 3.1 How the pieces fit

| Control | Role in the ladder |
| :-- | :-- |
| `agent_config.auto_publish` (U) | L0 vs L1+. Admin-only control (0086 lists the key). False: allowed videos are held, nothing uploads |
| `channels.auto_publish` (C) | not a level. Admin-only (0086). Not plainly true: a run's privacy is clamped to private. Chronos: off |
| `channels.publish_on_approve` (0116) | L2. Admin-only RPC; reset when a channel changes organization |
| new `publish_after_gate` | L3. Same shape as 0116's switch |
| `NIGHTSHIFT_PIPELINE_PAUSED` | stops *scheduled* runs only (fails closed). Ladder level is unchanged; paused periods are not failures. **Does not stop flips today** (verified above) |
| worker locks | `NIGHTSHIFT_VISIBILITY_PUBLISH` (0116). L3 adds `NIGHTSHIFT_POLICY_PUBLISH`, default off. Both must be on for a policy flip |
| publish gate | runs before upload (unchanged). Its stored verdict is checked again at every flip (`video_publish_refusal`). L3 requires the gate not weakened (D10) |
| 24 h approval expiry | L2 only: an approval older than 24 h is `expired`, not published. L3 has no approval; it has a hold-back window instead |
| `require_two_person_publish` | a channel with it on cannot be promoted to L3. Note: 0116 states two-person is not re-checked at flip time, so L2 may let one admin do what the flag was meant to require (open question 13) |

**Requirement that follows from the pause finding:** a policy flip must refuse while the global pause is truthy in the worker environment (same fail-closed parser as `pipeline_paused()`). Whether person-approved flips should stop too is open question 10; my recommendation is yes ("paused means paused").

### 3.2 L3 mechanics (design only)

1. Upload happens as today: private.
2. Hold-back window, default **6 h** (proposal; minimum 2 h; unverified how long YouTube needs).
3. A trusted worker enqueues a request with `origin = 'policy'` only if, at that moment, from fresh sources: switch on, channel at L3, video private and uploaded, gate verdict stored and allowed, cut unchanged, no ladder event since upload, global pause off, YouTube status read shows processed and not rejected.
4. The existing worker does its re-checks, flips, reads back. `applied` only on read-back `public`.
5. Any doubt ends the request `refused` and the video stays private. A human veto in the window is: Channels switch off, delete in Studio, or the global pause.

Acting inside a grant a human gave is not the system widening its own power; but it is "the bot publishes without a person tapping", so it needs its own amendment of rules 2 and 3 (a second named exception, written by the owner). Not drafted here.

### 3.3 Data-model options

| Option | Verdict |
| :-- | :-- |
| A. Derive L0 to L2 from existing columns | **Use.** No migration for phases 1 to 3 for these levels |
| B. New column `publish_after_gate` + demote function | **Use for L3** (phase 4) |
| C. Key in `agent_config` | Rejected. Editors can write `agent_config`; the 0086 guard only protects listed keys; the service key bypasses it |
| D. Stored `autonomy_level` int | Rejected. Two sources of truth beside the booleans; drift is a safety bug |

### 3.4 Migration shapes (NOT written; numbers are placeholders after 0116 merges)

**(i) Phase 3, `0114`: demotion and audit.** Additive, idempotent, in the style of 0086 and 0116.

- `create or replace function public.demote_channel_autonomy(p_channel_id text, p_to smallint, p_reason text, p_detail jsonb) returns jsonb`, `security definer`, `set search_path = public, pg_temp`.
  - Callable only by `credits_trusted_caller()` (the service key). `revoke all ... from public, anon, authenticated; grant execute ... to service_role`.
  - Locks the channel row FOR UPDATE; computes the current derived level; **only lowers** (`p_to` must be below it, otherwise `{ok:true, changed:false}`).
  - Sets, top down, `publish_after_gate`, `publish_on_approve` to false and, for level 0 only, `agent_config.auto_publish` to false (`jsonb_set`) as `p_to` requires. It never touches the column `channels.auto_publish`. HALT reasons also set `status = 'PAUSED'`.
  - `p_reason` must be in a closed list: `gate_blocks, qc_blocks, run_failures, upload_failures, topic_failures, quota, spend, platform_kept_private, youtube_rejected, youtube_removed, disclosure_gap, owner_reversal, gate_weakened, project_wide`. `p_detail` holds counts and ids only (no titles, no free text).
  - Refuses waiting visibility requests whose write is not yet marked (same `where ... submitting_at is null` as the 0116 switch function).
  - Writes one `app_audit_log` row `channel.autonomy_demoted` (actor null = system) and returns `{ok, from, to, reason}`.
- `create or replace function public.audit_action_allowed(text)`: the 0116 list verbatim plus `channel.autonomy_demoted`, `channel.publish_after_gate`.
- Optional hardening **H1** (open question 9): replace `channels_config_guard` with its 0086 body verbatim plus one rule: `service_role` may not change the column `auto_publish`, or the `agent_config` key `auto_publish`, from not-true to true. No dashboard code writes either with the service key (grep found none); who else writes `agent_config` with it is UNVERIFIED (the registry mirror might), so check before writing H1. The SQL editor still can.
- Rollback `docs/sql/rollback_0114_autonomy_demote.sql`: drop the function, restore the two replaced bodies byte for byte, as 0116's rollback does.

**(ii) Phase 4, `0115`: the L3 switch.**

- `alter table public.channels add column if not exists publish_after_gate boolean not null default false;` plus `add constraint channels_publish_after_gate_needs_approve check (not publish_after_gate or publish_on_approve)`.
- Trigger `channels_autonomy_switch_guard`, copy of `channels_publish_switch_guard`: `before insert or update of publish_after_gate, org_id`; refuses `anon`, `authenticated` and `service_role` any change outside the RPC; resets the column when `org_id` changes.
- `set_channel_publish_after_gate(p_channel_id text, p_on boolean, p_ack jsonb) returns jsonb`: `security definer`; `auth.uid()` required; organization from the channel row; `is_org_member(org,'admin')` and `video_real_member(org,'admin')`; `take_web_rate('autonomy_switch', 10, 600)`. Turning ON also requires `publish_on_approve` and `auto_publish` true, `require_two_person_publish` not true, gate not weakened, a typed word, and `p_ack = {"studio_checked": true}`. Writes the audit row. Turning OFF refuses waiting policy requests as above.
- `video_visibility_requests.origin text not null default 'person' check (origin in ('person','policy'))`; `visibility_request_refusal` branches on origin; `enqueue_policy_publish(p_video_id)` is service-only and re-runs every check in 3.2.
- Rollback `docs/sql/rollback_0115_publish_after_gate.sql`: switch all channels off, drop functions and trigger, restore replaced bodies; keep the column as 0116's rollback keeps its own.

Neither migration is applied by this PR. Per `CLAUDE.md`: additive only, applied by hand, merge applies it.

---

## 4. Chronos, concretely

Current state (coordinator, from the live row; not read by me): ACTIVE, 22:00 UTC enabled, `channels.auto_publish` off, no `auto_publish` key in `agent_config` (upload), 0 videos. By the table in 1.1 that is **L1 today**: if tonight's 22:00 UTC run produces a video the gate allows, it is uploaded as private, `review_state` is 'pending', and Approve is available. Nothing needs switching to start plan A.

Because tonight's run uploads, the preflight is for **today**: `NIGHTSHIFT_PIPELINE_PAUSED` unset (or set, if you want to wait); `spend_ceiling_usd` set and `CHRONOS_PRICE_*` variables set (otherwise cost is unknown and the caps never fire); `publish_gate` untouched; `ai_disclosure` left at `auto`; `require_two_person_publish` off; scheduled readiness check green. If you would rather look at video 1 before anything reaches YouTube, set `agent_config.auto_publish` to false first (back to L0, one config edit), then remove the key after video 1 (open question 1). I recommend not doing this: a private upload costs nothing publicly and shows you the YouTube side (processing, label, captions) that a held copy cannot.

**Videos 1 to 7: L1 (choose 5 to 10).**
Each night: private upload. Next morning, open the video in Studio and the app. Wait about an hour after upload so processing and automatic checks have run. Video 1 gets extra attention: it is the first end-to-end look at the whole pipeline.

Phone checklist, about 3 minutes:

1. Plays start to end, sound ok, no cut-off ending.
2. First 15 seconds: a real hook, not filler.
3. Two facts spot-checked (a date and a name). Any flagged claims noted by the gate?
4. Nothing about a real, living person that could be read as false or defamatory; nothing graphic.
5. Footage: no obviously copied clips or logos; rights "unknown" is normal, "blocked" would have stopped it.
6. Studio shows "altered or synthetic content: Yes" and the description line, if generated media was used.
7. Title and thumbnail promise what the video delivers; no invented superlatives.
8. Captions present and in the right language; chapters sensible.
9. Description and tags contain no leftover prompt text or placeholder.
10. Studio shows no copyright or restriction badge after processing.

Good: tap **Approve**. Bad: do not approve (and optionally delete or leave private). Two side effects to know: Approve does not change privacy; it does make the cross-post rail (Instagram, TikTok "publish to platforms") available, because that rail reads `review_state = 'approved'`.

**A bad video, by kind.**
- Blocked by the gate: nothing is uploaded (the gate runs before the upload at any level); a held row explains the block. No action needed. Two blocks in five warns or demotes (D1).
- Uploaded but bad: not approved, stays private, deleted if you wish. Today the reason is not recorded (section 1.3). It counts as "not approved". If it is systemic (voice, visuals, topic style), change the DNA or voice; the window does not restart on its own, so tell me and I will mark it (open question 11).
- Already public (L2 or L3) and bad: set it private in Studio. Phase 2 reader notices and D9 demotes to L1.
- Copyright claim, restriction, strike: HALT class (D4/D5).

**When to flip.**

| Step | When | Needs |
| :-- | :-- | :-- |
| (L0 to L1) | not needed: Chronos is at L1 | only if you set it back to hold |
| stay at L1, publish by hand in Studio | any time | nothing new; works today |
| L1 to L2 | after 7 clean approved videos (video 7 or later) **and** 0116 released | rule 2/3 amendment applied, legal and consent text, live test passed, worker lock on, then your tap |
| L2 to L3 | after 10 clean videos with 5+ real flips | phase 4 built, second amendment, then your tap |

So: "first 5 to 10 private, then auto-publish" is achievable as *private for 7 videos, then you publish by hand or with one tap* in the near term. Fully automatic public publishing is the end of phase 4 and depends on things only you and YouTube can unlock.

---

## 5. Edge cases

- **Customer channels.** Never scheduled (a customer's run starts from the Command Center with its credit hold). They can use L0 to L2 under their own org admins; platform admins cannot flip their switches (0112/0116 rule). L3 is **out of scope** for customers until there is customer-facing legal and consent text and you decide. Their evidence is never sent to the operator bot (the bot ignores customer channel rows). A demotion on a customer channel needs an in-app notice to their org (phase 5; until then the automatic demotion is not applied to customer channels, only HALT-class platform signals are, and shown on their Channels page).
- **Schedule changes.** `publish_hour_utc` or `enabled` changes do not touch the level or the window; windows count started runs. A channel re-scheduled mid-window keeps its evidence.
- **Paused and unpaused.** Global pause: no scheduled runs, no failures counted, level unchanged; the dead-man alert may speak (I found no pause handling in `modules/operator_bot`: a separate pre-existing question, not verified). Channel PAUSED by a person: the same. PAUSED by HALT: unpausing is the promotion act (same screen, same evidence).
- **Channel moved between organizations.** 0116 already resets `publish_on_approve` on an org change. The ladder adds: `agent_config.auto_publish` (to hold), the column and `publish_after_gate` reset too, the window restarts, level L0. The new org's admins did not choose the old grant. (Needs a trigger extension; today only `publish_on_approve` resets.)
- **Videos deleted on YouTube.** The `videos` row stays. With the phase 2 reader, a missing or deleted video is "withdrawn": it counts as not approved for the window, and a *published* one deleted within 7 days is D9. Owner-deleted and YouTube-removed cannot be told apart; both count the same, honestly labelled.
- **Unaudited API project forcing private.** Detected in two places: the 0116 read-back (`platform_kept_private`) and, in phase 2, the observed privacy after upload compared with what we asked for. Never counted as a publish. It is a HALT-class, project-wide event. Caution: `platform_kept_private` can in principle be a slow propagation misread (the #543 doc says so), so the halt is reversible by an admin who has checked Studio.
- **Token revoked or scope missing.** Counts as operational failure (D3); `scope_missing` at flip time is D4.
- **Repairs and resumes.** A scene repair voids the approval (0112) and produces a new cut of the *same* run: one video in the window, judged on its final cut.
- **Manual dispatch.** Someone with repository write access can dispatch a run with `privacy = public`. On a channel whose column `channels.auto_publish` is not plainly true (Chronos today) that is clamped to private (`channels.py:537-548`); where the column is on, it goes public. The ladder governs the bot, not people with repo access, and manual runs are not evidence. A test should keep pinning that the *schedule* can never request public.
- **Shorts.** Excluded from evidence (`parent_video_id` set); they stay private (0116).
- **YouTube API quota.** `videos.insert` ~1600 and `captions.insert` ~400 per video leave room for about 4 to 5 videos a day per OAuth project before any flip (50 each), thumbnails or comments (costs not in the repo table; unverified). One project, many channels, is a real ceiling for "an autonomous pipeline per channel".

---

## 6. Phases, tests, risks

### 6.1 Phases

| Phase | What | Owner decision? |
| :-- | :-- | :-- |
| 1 (smallest PR) | `modules/autonomy_ramp.py` pure evaluator + `tools/autonomy_report.py` CLI + unit tests. Read-only, no migration, no alert, no import of any publishing module | thresholds only (constants, reviewable) |
| 2a | Record the *observed* privacy from the insert response (verify first); stop storing the requested value as if measured | no (records only, rule 5) |
| 2b | Post-upload status reader (`videos.list part=status`, ~1 unit): withdrawn, rejected, observed privacy | scope check (Scout) |
| 2c | `reject_video` RPC with closed reason words, modelled on `approve_video_publish` | yes |
| 2d | Alerts: recommendation (`approval`), demotion (`pipeline`); `/channels` shows the level | yes: alert kind |
| 3 | Migration `0114` demote function; `if: always()` + `continue-on-error: true` applier step after each channel job; lab tests | yes: thresholds, HALT pauses channel, hardening H1 |
| 4 | L3: migration `0115`, policy origin, worker lock, pause honoring, UI, **second rule amendment** | yes: all of it |
| 5 | Customer channel notices (in-app) | yes |

Phase 1 touches nothing that publishes. Phases 2 and 3 only move in the restrictive direction, like the publish gate. Only phase 4 adds power, and it is gated on 0116 being released.

The operator bot stays read-only: it *decides and tells* (as `reliability.py` does); only a workflow step with the service key applies a demotion.

### 6.2 Test plan

Security lab (scratch Postgres 16, `tests/security/test_sec_autonomy_ramp.py` + `sec_autonomy_0114.py`, style of `test_sec_visibility.py`):

- anon, authenticated and the service key cannot write `publish_after_gate` directly (insert and update) and cannot promote by any route.
- Editor, non-admin, platform admin on a customer channel: refused. Admin who is a real member: allowed once, audited, rate-limited, typed word and acknowledgement required.
- Cannot jump two rungs; cannot turn L3 on without L2 and upload (U); refused with `require_two_person_publish` or a weakened gate.
- `demote_channel_autonomy`: not callable by anon or authenticated; service key only; can only lower; closed reason list; idempotent; refuses waiting unmarked requests; audit row without free text; HALT pauses.
- Org move resets all three switches; rollback restores the two replaced bodies byte for byte; re-apply is idempotent.
- (If H1) service key cannot set the column or the `agent_config` key `auto_publish` from not-true to true.
- `demote_channel_autonomy` never writes the column `channels.auto_publish`.

Python (`tests/test_autonomy_ramp.py`):

- Table-driven evaluator: unknown never promotes and never demotes; required cell unknown means no READY; forced-private is never a success; paused gaps are not failures; window restarts at the last ladder event; 2 and 3 consecutive failures; thresholds at the edges.
- Static test: `autonomy_ramp.py` imports none of `youtube_uploader`, `visibility_publish`, `publish_gate` writers.
- Messages contain ids and closed words only, no titles.
- A test pinning that the scheduled path of `daily_video.yml` resolves to `private`.
- Mutation checks as #543 did: break one rule at a time, a named test must fail.

Frontend (phase 2d and later): the three-language strings, the level pill with the reason, `vitest` + `tsc` + `next lint` + `next build`.

### 6.3 Risks

- **Thin evidence** (section 1.5). Mitigation: honest wording; hold-back and fast demotion carry the safety.
- **False demotions** from flaky infrastructure (the runner has died at exit 143). Mitigation: counts over started runs, two in a row, unknown never demotes.
- **False comfort**: a green report while YouTube-side state is unread. Mitigation: those cells are unknown until phase 2b; no READY with unknowns.
- **Stale events** (22 h lag) hiding a recent failure. Mitigation: decisions that must be fresh use `videos` rows and fresh reads only.
- **A demotion bug that never fires** is silent. Mitigation: the applier logs every pass; add the evaluator to the existing `operator.doctor` check (phase 3).
- **Scope creep toward L3 before the platform answers**: the live test may show the project cannot publish at all, which makes L2 and L3 moot until an audit. The ladder degrades safely to L1.
- **Legal text**: #544 covers publish-when-approved only; L3 needs new wording and possibly re-verification with Google (unverified).

---

## 7. Open questions for you

1. Chronos is at L1 today and tonight's run uploads privately. Keep it so (recommended), or set `agent_config.auto_publish` false for the first video? And `N1`: 5, 7 or 10?
2. Is L3 (automatic public after a hold-back, with its own rule amendment) wanted at all, or is L2 (one tap) the ceiling for now? If L3: hold-back 2 h, 6 h or 12 h?
3. May Chronos skip L2 and go L1 to L3? (I recommend no: L3 reuses L2's machinery, and L2 proves the project can publish.)
4. Do you want a **Reject** button with reason words (factual error, voice, visuals, off topic, policy risk, other)? Without it, rejections stay unmeasured.
5. HALT alert severity: reuse `pipeline` (warn, held in quiet hours) or add a critical `autonomy` kind?
6. The "Studio shows no strike or limit" statement is typed into the promotion screen because strikes are invisible to us. Acceptable?
7. Do the operator channels and customer channels share one Google OAuth project? (Decides how wide a forced-private halt must be.)
8. Customer channels: L0 to L2 only, in-app notice on demotion, L3 never for now. Agree?
9. Harden the database so the service key cannot turn `auto_publish` on, column or config key (H1)? Small migration, closes a gap beside the 0116 guard.
10. Should the global pause also hold person-approved flips (L2)? I recommend yes.
11. If you change a channel's DNA, voice or niche mid-window, should the evidence restart? Today such edits are not audited, so I cannot detect them.
12. Are the thresholds in 1.4 and 2.2 right for your risk appetite (2 of 5 blocks, 2 failures in a row, 14 days freeze, 48 h settling)?
13. 0116 does not re-check `require_two_person_publish` at flip time. Intended?
14. Should HALT pause the channel (stops spend) or only set level 0?
15. You said quality, topics, schedule and error-free running come first. Should phase 1 also report topic quality beyond duplicates (for example repeat rate, near-duplicate warnings, topic-selection failures per week)? The local topic queue (`history/`) is not durable on Actions runners, so queueing the first ten topics ahead is not reliable; the workflow's `topic` input is.
16. Should the evaluator treat the Channels-page column being ON as a defect at L1 and above (it lets a manual run go public), or only as a note? The owner's wording "auto_publish=false" refers to this column.
