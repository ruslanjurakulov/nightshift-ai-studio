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
3. The queue worker (`NIGHTSHIFT_VISIBILITY_PUBLISH=on`, off by default) claims the row (organizations are served in turn) and asks the
   database: `video_publish_refusal(video_id, cut_sha256)` with the hash recorded at approval (uploaded, gate verdict stored and
   allowed, same cut, approved by a person, not expired, not public already) and `visibility_request_refusal` (switch still on, still
   THE approval, channel still in the organization it was queued for, channel connected). That early pair is a cheap filter. The
   check that counts is the last one: `mark_visibility_submitting` asks the same two questions again **inside the transaction that
   sets the "the write may be sent" marker**, under row locks (the channel row FOR SHARE, the request FOR UPDATE, the video FOR
   SHARE), so a cut change, a repair, an expiry, a privacy change or a switch turned off between the early check and the marker is
   caught there and nothing is sent. Any word ends the request without a YouTube write.
4. It checks the token's scopes (and that it knows which YouTube channel the token must reach), the quota budgets (the day's and the
   organization's share; write = 50 units), reads the video from YouTube (right channel, processed, private, **and the read contains the
   made-for-kids declaration and the privacy**, else `status_unreadable` and nothing is sent: `part=status` replaces the whole part),
   sends `videos.update(part="status")` once, then **reads the privacy back**.
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
| `NIGHTSHIFT_VISIBILITY_ORG_PERCENT` | one organization's share of that day, percent 1-100 (100 = no per-organization cap) | **50** (about 9 flips a day per organization) |
| `NIGHTSHIFT_YT_QUOTA_PROJECT` | label of the Google Cloud project in the ledger | `default` |
| `PUBLISH_ON_APPROVE_RELEASED` (the Command Center's server, a repository variable) | shows customers the Channels switch and "Approve and publish" | **off** (empty) |

A request nobody carries out stays `queued` until its approval ends (24 hours) and becomes `expired`.

## Fairness and bounds

* **Quota.** The ledger holds the project's whole day and, per organization, its spend (`youtube_quota_ledger.org_id`; the all-zero id is
  the whole day). A take passes only if both ceilings hold, serialized per project, and a refused take records nothing. One tenant can
  therefore use at most `NIGHTSHIFT_VISIBILITY_ORG_PERCENT` of the day (default 50%: with the default 1000 units that is about 9 flips a
  day per organization; the rest of its requests end `failed / quota_exceeded` and an administrator tries again later). A read-back is
  recorded against the organization even past its share (it is never withheld: the read-back is the truth).
* **Order.** `claim_visibility_request` serves the organization served longest ago first, so one tenant's pile of requests does not
  keep another's waiting.
* **Attempts.** A round is three claims; "Try again" (`retry_video_visibility`) starts a new round but the request's
  `lifetime_attempts` never resets: **six claims in all**, then the request stays `failed` and "Try again" answers `retry_limit` (the panel
  stops offering it). A person then checks YouTube Studio or approves again.

## The switch turned off while a write may be on its way

Turning the channel off refuses every waiting request at once, **except one whose write was already marked** (`submitting_at` set):
refusing it could leave the database saying "not published" about a video that is public. That request stays `queued`; the worker
reads YouTube back and `finish_visibility_request` (which never looks at the switch) records what YouTube says: `applied` with
`after_privacy = 'public'`, `videos.privacy` mirrored, an audit row (`write_marked: true`). The expiry sweep leaves a marked request
alone for the same reason. If the worker died, the next claim (told to `reconcile`) READS YouTube first even when the database now says
no (switch off, approval expired): public means `applied`, anything else ends with the database's own word, and YouTube is never written
to on that path. If that read fails (token, quota, 5xx) the request goes back to the queue rather than ending as "not published".
The worker checks the database's answer to its own finish: a request the database did not record is logged at ERROR for `applied`
(YouTube said public, the request does not) and at WARNING otherwise, and is never logged as applied.

`platform_kept_private` means: the write was accepted and **two** reads (a few seconds apart) both said private. A slower propagation than
that would read the same and is not corrected afterwards (the request is final); check Studio if in doubt.

**Reconcile cannot tell who made the video public.** After a crash, public on that first read is recorded as `applied`, whether our write
landed or a person made it public in Studio in the same minutes. The audit row says the write was marked (`write_marked`), nothing
more; the read-back is the truth being recorded, not the cause.

A channel moved to another organization comes out switched off (the trigger resets it whoever moves it), and a request queued for the
old organization is refused (`not_enabled`) by the re-check.

## Releasing it

Hidden until released, on purpose: the legal pages and the Google consent text still say Nightshift never edits an existing video.
The Command Center shows **nothing** of the feature until the server flag `PUBLISH_ON_APPROVE_RELEASED` is on (default off; an unset,
empty or odd value is off; it is a server variable read per request, **not** `NEXT_PUBLIC_`, so no build can leave it on). With it off
the Channels page draws no switch (the channel's value is not even sent to the browser), the video page's key reads "Approve"
everywhere, there is no "Approve and publish" and no request status. The database functions stay callable (an administrator who
calls the RPC by hand can still switch a channel on; the worker then still has its own switch): the flag hides the doors, it does not
lock them. Release, in this order, each step only after the one before:

1. Owner approves the CLAUDE.md rule 2/3 amendment (`docs/proposals/claude-md-rules-2-3-phase-1b.patch`) and merges.
2. Legal text and Google consent text changed (the section above) and, if Google asks, the OAuth app re-verified.
3. The live test below passed on a disposable channel (the three unverified answers recorded).
4. Worker: `NIGHTSHIFT_VISIBILITY_PUBLISH=on` (+ ceiling and organization share if the defaults are wrong).
5. Web: repository variable `PUBLISH_ON_APPROVE_RELEASED=on`, then deploy web (it is a key of `deploy/.env.web.example`, mapped in
   `deploy_web.yml`; a restart is enough, it is read per request).
6. Only then tell customers; each channel's administrators still opt in per channel.

To take it away again: unset the web variable (the UI disappears), unset the worker variable, switch channels off.

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
