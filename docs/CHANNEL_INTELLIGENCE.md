# Channel Intelligence — P0 integration specification

Status: **documentation only; proposed behavior is not enabled**. Evidence date:
2026-11-15; repository baseline `f985b3afd371c0677357670da436ef2074fdb036`
(migration files through 0174; applied production state unknown). This specification extends [Intelligence](INTELLIGENCE.md),
[Results dashboard](RESULTS_DASHBOARD.md), [Multi-channel](MULTI_CHANNEL.md),
[Social setup](SOCIAL_SETUP.md) and [Measurement](MEASUREMENT.md). It does not
replace existing collectors, authorize a consent change, or establish live
deployment readiness.

## Existing implementation and evidence boundaries

| Component | Source | Audit result |
| --- | --- | --- |
| Own-channel metrics and retention | `modules/analytics_client.py`, `modules/intelligence_poller.py` | Implemented client and scheduled poller; actual grant, successful responses and freshness must be verified separately. |
| Competitor uploads/public statistics | `modules/competitor_monitor.py` | Official channels/playlistItems/videos calls. No competitor private analytics. |
| Regional popular videos | `modules/trend_detector.py` | `videos.list(chart=mostPopular)`; this is one limited signal, not universal trend or keyword demand coverage. |
| Audience topic requests | `tools/run_intelligence_poll.py`, `modules/audience_demand.py` | Classified comments become per-channel demand signals; clustering is heuristic text similarity. |
| Learning and recommendations | `modules/feedback_engine.py`, `modules/learning_memory.py`, `modules/strategy.py` | Reuse existing evidence and approved learnings. Do not create a second scoring or memory authority. |
| Results dashboard | `command-center/app/(app)/[channel]/analytics/results/page.tsx` | Implemented behind `NIGHTSHIFT_RESULTS_DASHBOARD`, default off; reads stored metrics, not live platforms. |
| Instagram/TikTok accounts and publishing | `command-center/lib/server/social-oauth.ts`, `modules/social_publish.py` | OAuth and publishing code exists; this does not imply analytics/comment permissions. |

Old architecture plans contain historical missing-feature claims. Source code
and a timestamped operational verification take precedence over those claims.
This audit did not connect to production or query a customer's account.

## Official platform capability and permission matrix

Official references were fetched read-only on 2026-11-15. A documented API
capability is not evidence that Nightshift's application has approval to use it.

| Platform/use | Official boundary | Current Nightshift gap |
| --- | --- | --- |
| YouTube own-channel analytics | OAuth-authorized owner's reports; supported metric/dimension combinations and eligibility apply. Retention uses `audienceWatchRatio`. Monetary reports need monetary scope and eligibility. | Validate consent and supported queries with approved fixtures before declaring available. |
| YouTube thumbnail CTR | Existing client requests `impressions,impressionClickThroughRate`; the official Analytics metrics list fetched on the evidence date did not list `impressionClickThroughRate`. | Treat as unverified/unavailable; do not promise a working CTR collector or silently replace it with engagement rate. Record an explicit capability probe result. |
| YouTube competitors | Public upload metadata and public statistics only. | Never claim competitor CTR, retention, demographics or revenue measurements. Estimates must be labeled and have an evidence method. |
| Instagram insights | Professional account access, `instagram_business_basic` and `instagram_business_manage_insights` for Instagram Login; approved access level and supported metrics required. | Current OAuth asks basic/content publishing, not insights. New scope, consent and app review are a separate rollout. |
| Instagram comments | Owned app-user media; `instagram_business_manage_comments`; Advanced Access for accounts the app does not own/manage. | Current OAuth does not request moderation permission; no audited comment collector found. |
| TikTok display statistics | Display API and approved relevant scopes, including video access, provide supported public video fields. | Current OAuth asks `user.info.basic,video.publish,video.upload`, not `video.list`; add only after product review and scope verification. |
| TikTok retention/comments/replies | No general commercial capability was verified in this audit. | Keep unavailable pending a documented approved product and real contract test. Do not assume parity with YouTube. |
| TikTok Research API | Eligibility includes non-commercial/not-for-profit public-interest research independent of commercial interests. | Not a shortcut for Nightshift's commercial analytics or comment service. |

References:

- [YouTube Analytics metrics](https://developers.google.com/youtube/analytics/metrics)
- [YouTube Analytics reports.query](https://developers.google.com/youtube/analytics/reference/reports/query)
- [YouTube quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)
- [Instagram insights](https://developers.facebook.com/docs/instagram-platform/insights/)
- [Instagram comment moderation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/comment-moderation/)
- [TikTok Display API](https://developers.tiktok.com/doc/display-api-overview/)
- [TikTok Research API](https://developers.tiktok.com/products/research-api/)

Quota is a capability/configuration record, not a timeless constant. On the
evidence date Google's quota page described separate default daily allocations
of 100 `search.list` calls, 100 `videos.insert` calls and 10,000 combined units
for other endpoints. Actual project allocations and method costs must be checked
before activation. No quota-expensive polling is enabled by this document.

## Target integration and logical contracts

Keep the existing poller and provider adapters. A collector records provenance;
deterministic readers calculate metrics; the Brain receives bounded evidence
and proposes a strategy. A strategy does not enqueue paid generation, alter a
publish gate or publish a video.

Proposed logical records, **not SQL or applied schema**:

- Capability grant: tenant/channel/platform, documented endpoint, requested and
  granted scopes, app access status, last probe, verification expiry and reason
  for unavailable. Never store a credential in this record.
- Observation envelope: tenant/channel/platform/source id, metric name/unit,
  `window_start`, `window_end`, `observed_at`, source timezone, aggregation kind
  (period, lifetime, ratio or point-in-time), value/null, revision and provenance.
- Strategy version: channel, goals, brand references, cited observations,
  coverage, uncertainty, recommendation horizon and immutable revision.

Do not sum overlapping two-day snapshots into a monthly total. Existing daily
poll snapshots are short windows, and old local decision readers assume early
life data. Preserve the separation of late observations described in
[Results dashboard](RESULTS_DASHBOARD.md); introducing a new normalized reader
must not change old decision inputs without its own reviewed change.

Every number includes its period, unit, freshness and coverage. Missing,
unsupported, stale and refused are distinct states; none means zero. Ratios are
recomputed from compatible numerator/denominator observations, not averaged
without weights. A strategy with insufficient data says so.

## Authority, memory and approval

Follow [AI Security Policy](AI_SECURITY_POLICY.md) and reuse the authorities in
[AI Memory Architecture](AI_MEMORY_ARCHITECTURE.md). The server derives tenant/channel identity from the authenticated actor and
membership. Model output and external text never choose an authorized tenant.
A narrow tool broker enforces server-side allowlists, resource ownership,
quotas, rate limits and global/org/channel kill switches before work and before
any consequential external action. Credentials stay inside existing adapters;
the Brain receives references and redacted results only.

Each channel's evidence and strategy remain isolated. Reuse approved learnings,
channel DNA and organization style/character references; any cross-channel
aggregation must be explicitly authorized and must not leak another customer's
raw content. Recommendations retain sources and revisions, not autonomous
changes to code or model weights.

Any future paid plan or write action needs an immutable approval bound to a
SHA-256 digest of canonical content: actor/tenant/channel, exact action and
model/version, inputs, output plan, quoted credits, limits and expiry. Backend
canonicalization rules belong to the shared approval contract. Any material
change invalidates approval and requires reapproval. The existing billing quote,
hold, capture/refund authority is reused; no duplicate customer/retail ledger.
Independent private platform-cost exposure reservations supplement existing
ledgers under SEC-04; they do not create a second customer charge.
Approving a strategy is not blanket permission to spend, publish or reply.

## Acceptance and rollout

1. Inventory deployed grants and successful collector evidence without exposing
   secrets; show unavailable capabilities honestly. No scope change in P0.
2. Contract fixtures cover unsupported CTR, missing metrics, expired consent,
   stale data, overlapping windows, lifetime/period mismatch and late revisions.
3. Verify one user's/channel's fixtures cannot influence another's strategy.
4. Shadow recommendations cite evidence and make no external writes or paid
   generation requests; compare to existing readers before any cutover.
5. After explicit reviewed implementation approval, opt in one channel behind
   a disabled-by-default feature gate. Check quota and all kill switches.
6. Extend platforms only after official capability, app approval, consent,
   successful adapter call and safe failure behavior are demonstrated. Rollback
   disables the new reader/feature; existing publishing and editors continue.
