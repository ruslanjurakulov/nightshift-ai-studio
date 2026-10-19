# Approve and publish, Phase 1b: the worker that makes an approved video public

Status: built, **DRAFT, dormant, and not to be merged before the owner has (1) approved the rule change in
`docs/proposals/claude-md-rules-2-3-phase-1b.patch` and (2) run the live test below on a disposable channel.**

Phase 1a (migration 0112, merged) made "Approve" a recorded decision bound to one exact cut. Phase 1b (migration 0113 + the
queue worker) lets a worker act on that decision, **only on a channel whose administrators switched "Publish when approved" on**.

## What happens, in order

1. An administrator of the channel's workspace turns **Publish when approved** on (Channels page; a sheet explains it and a word is
   typed; one tap turns it off). Default OFF for every channel. Written only by `set_channel_publish_on_approve()`, audited.
2. A person (admin of that workspace, a real member of it) watches the video and presses **Approve and publish** (the label says
   publish only on such a channel; everywhere else it is "Approve"). `approve_video_publish` records the decision as in 0112 and,
   because the switch is on, queues one `video_visibility_requests` row for this approval act.
3. The queue worker (`NIGHTSHIFT_VISIBILITY_PUBLISH=on`, off by default) claims the row and, before and again immediately before the
   write, asks the database: `video_publish_refusal(video_id, cut_sha256)` with the hash recorded at approval (uploaded, gate verdict
   stored and allowed, same cut, approved by a person, not expired, not public already) and `visibility_request_refusal` (switch still
   on, still THE approval, channel connected). Any word ends the request without a YouTube call.
4. It checks the token's scopes, the day's quota budget (`youtube_quota_ledger`, write = 50 units), reads the video from YouTube
   (right channel, processed, private), sends `videos.update(part="status")` once, then **reads the privacy back**.
5. The row ends as `applied` only if YouTube then says `public`; `refused` with `platform_kept_private` if the call succeeded and the
   video is still private; otherwise another closed word. `videos.privacy` follows the read-back alone. The panel says
   Queued / Published (only from that read-back) / Not published (reason in words) / Expired.

Every failure leaves the video private, which is the safe state.

## The switches and settings

| Where | What | Default |
| :-- | :-- | :-- |
| `channels.publish_on_approve` | per channel, admin-only RPC | **off** |
| `NIGHTSHIFT_VISIBILITY_PUBLISH` | the worker step itself (`on` / `1` / `true` / `yes`) | **off** |
| `NIGHTSHIFT_VISIBILITY_DAILY_UNITS` | this feature's YouTube units per Pacific day, 0-10000 | 1000 (about 19 flips) |
| `NIGHTSHIFT_YT_QUOTA_PROJECT` | label of the Google Cloud project in the ledger | `default` |

A request nobody carries out stays `queued` until its approval ends (24 hours) and becomes `expired`.

## Deploy order and undo

Apply 0113, deploy the app and the worker of the same commit, leave both switches off. Details and the replay rules:
`docs/MIGRATIONS.md` ("Publish when approved (0113)"). Undo for behaviour: switch the channel off (its queued requests are refused
at once) or unset the worker variable. Undo for the objects: `docs/sql/rollback_0113_visibility_requests.sql` (before rolling back 0112).

## Where the merged code and the design document differ (the merged code wins)

* 0112's `approve_video_publish` creates no request row and its replay returns `already: true`; 0113 adds the request in a block after
  its audit write (unique per `(video, cut, decided_at)`), so a replay never queues twice. The design's `intent_id unique` was not used.
* 0112's `video_publish_refusal` does not contain the design's `channel_not_connected`, `not_enabled`, `awaiting_two_person`: those
  checks are in `visibility_request_refusal` (two-person is not re-checked; the product dropped it).
* The status vocabulary is `queued | applied | refused | failed | expired` (no `applying`, no `cancelled`): a lease on a queued row
  replaces `applying`; a repair is caught by the worker's re-check (`not_approved` / `approval_superseded`), so
  `finish_scene_regeneration` is not touched again.
* A `failed` request (token expired, quota, scope, channel not connected, ...) can be re-queued by an admin
  (`retry_video_visibility`), because 0112's replay would otherwise leave an approved video with no way to try again.
* `publish_channel_connected` (0029) arrived by a later edit, so 0113 carries `visibility_channel_connected` (same rule).

## The YouTube scope question

`videos.update` requires one of `youtube`, `youtube.force-ssl` or `youtubepartner` (verified on
developers.google.com/youtube/v3/docs/videos/update, 2026-10). **`youtube.upload` alone is not enough.** The scope list the app
already requests (`config.YOUTUBE_SCOPES` and `command-center/lib/server/google-oauth.ts`) already contains `youtube.force-ssl`, so
**no new scope is needed and none was added**. Consequences:

* A token granted before `youtube.force-ssl` was added (an operator token never reconnected; config.py says so) lacks it: the worker
  reads the scopes from the token document itself and ends the request as `scope_missing` ("reconnect the channel") without asking
  YouTube. Unknown scopes count as missing.
* `youtube.force-ssl` is a broad scope that already permits editing and deleting videos. The legal text and the OAuth justification
  say "Nightshift never ... edits your existing videos": that sentence becomes false for this feature and must change (below).
  If the owner prefers a narrower grant, there is none: `youtube` is broader, `youtubepartner` is for partners.

## Documents that must change before the feature is switched on for anyone (not changed in this PR: the owner decides the words)

`docs/GOOGLE_OAUTH_VERIFICATION.md` section 4 (and the consent-screen justification text, in English, as submitted to Google):

* `youtube.force-ssl`: add "changes the visibility of a video Nightshift uploaded from private to public (videos.update,
  status.privacyStatus), only when the channel's administrator has switched on 'Publish when approved' and a person approved that
  exact version; reads the video back to confirm". Remove "never edits existing videos" and say instead that it edits only that one
  field, only on a person's approval.
* `youtube.upload`: "Uploads are private by default" stays true; add that the channel's own switch can make an approved one public.
* Section 5 (demo video): show Channels page switch, the sheet, approving, the queued state, then the video public in YouTube Studio.
* Section 6: the API compliance audit / quota extension is now relevant (see "What is not verified").

`command-center/lib/legal-docs/{en,ru,uz}.ts` (privacy section 3 scope table and section 4 "How we use Google user data";
`tests/legal-docs.test.ts` checks the scopes are named): the `youtube.force-ssl` row says "never edits your existing videos"; the
`youtube.upload` row says uploads are private "unless you choose otherwise ... auto-publish"; terms (the section that puts
AI-label responsibility on the customer, legal-docs/en.ts) should say that approving with the switch on asks YouTube to make the
video public. Section 4 should list "making an approved video public" among the user-facing features.

## Manual live test on a disposable channel (the owner or the session runs it once; nothing here can be run from CI)

Use a channel nobody watches, a throwaway video, and the real OAuth project. Stop at the first line that does not read as written.

0. Preconditions: 0113 applied on a **branch or the live project only if the owner so decides**; worker deployed with
   `NIGHTSHIFT_VISIBILITY_PUBLISH=on` and `NIGHTSHIFT_VISIBILITY_DAILY_UNITS=200`; the disposable channel connected with a token that
   includes `youtube.force-ssl`; one video uploaded private by the pipeline (it has `cut_sha256` and a stored gate verdict).
1. `select publish_on_approve from channels where channel_id = '<ch>';` reads `false`. Approve the video on a channel with the switch
   off: it reads "Approve", the video stays private on YouTube, no `video_visibility_requests` row exists.
2. Channels page: switch **on** as an admin. Type the word. `select * from app_audit_log where action = 'channel.publish_on_approve'` has one row.
3. Try as an editor and as a platform admin on a customer channel: both refused.
4. Approve the video ("Approve and publish"). Expect: one `queued` request; the panel says Queued; the worker log says
   `visibility request N: applied` or a word; **YouTube Studio** shows the video public; `select status, after_privacy, quota_units,
   before_privacy from video_visibility_requests` reads `applied | public | ~53 | private`; `videos.privacy = 'public'`.
5. **The three things only the live API can tell (record the answers in the PR):**
   a. Did `videos.update` by this OAuth project make the video public at all, or did YouTube keep it private (the worker then writes
      `refused / platform_kept_private`, and the panel says so)? If kept private, Phase 1b is useless until the audit passes: leave the
      switch off for everyone.
   b. Did the request body (`status` = embeddable, license, publicStatsViewable, selfDeclaredMadeForKids, privacyStatus) leave the
      video's other settings (comments, license, made-for-kids, embeddable) unchanged in Studio? If anything changed, stop.
   c. Units: the ledger row for today vs the Cloud console quota graph (expect 53 for a flip: channels.list 1, videos.list 1,
      videos.update 50, read-back 1; a second read-back read only when the first was not public).
6. Failure paths on a second throwaway video: (i) revoke the channel's Google access, approve, expect `failed / token_expired` and a
   "Try again" button that works after reconnecting; (ii) set the day's ceiling to 10 and approve, expect `failed / quota_exceeded`;
   (iii) approve, then before the worker runs switch the channel off, expect `refused / not_enabled`; (iv) approve, then re-render or
   repair the video, expect `refused / not_approved` or `approval_superseded`; (v) stop the worker, approve, wait past the approval's
   expiry, expect `expired` and "Approve again"; (vi) set the video to unlisted in Studio before the worker runs, expect `refused /
   privacy_changed` and the video left unlisted.
7. Switch the channel off again. Confirm `select count(*) from channels where publish_on_approve` is 0 and unset the worker variable.

## What is not verified here

* Any real YouTube call: the worker is tested with a mocked transport only. The body that `videos.update` accepts (which returned
  status fields are read-only), the cost of `videos.list`, and whether an unaudited project's videos can be made public are
  unverified until the live test. The official `videos.insert` page currently says videos from unverified projects are *not*
  restricted to private; an older 2020 announcement said they are. The read-back is what makes either answer safe.
* Copyright / Content ID claims and AI-content labelling are not visible to this API and are not checked (the approval sheet still
  carries the rights-and-labels acknowledgement).
* Shorts cut from the video are untouched (they stay private).
