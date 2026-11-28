# Reporting Intelligence — P0 integration specification

Status: **documentation only; no schedules, exports or schema are created**.
Evidence date: 2026-11-15; repository baseline
`f985b3afd371c0677357670da436ef2074fdb036` (migration files through 0174;
applied production state unknown). Extend [Results dashboard](RESULTS_DASHBOARD.md),
[Measurement](MEASUREMENT.md), [Intelligence](INTELLIGENCE.md) and
[Channel Intelligence](CHANNEL_INTELLIGENCE.md), reusing their canonical data.

## Existing versus proposed

The results page and `/api/results` read stored own-channel YouTube snapshots
and workspace publish history under the member's session. The results feature
is gated by `NIGHTSHIFT_RESULTS_DASHBOARD`, default off. Its Instagram/TikTok
cards do not establish analytics availability. Cost, credit and learning data
already have existing writers/readers; reuse them rather than invent numbers.

The current billing provider also has an invoice-PDF route
(`command-center/app/api/billing/dodo/invoice/route.ts`); that is an existing
billing document download, not an analytics report exporter.

Dedicated per-user daily/weekly/monthly report snapshots, recurring report
scheduling and PDF/CSV report exports were not found in this read-only audit.
These are proposed additions. A dashboard or historical document is not proof
of a complete live reporting flow, correct provider grants or current data.

## Period, timezone and metric semantics

The default user-facing timezone is **Asia/Tashkent**, overridable by an explicit
per-user IANA timezone preference. Use that preference consistently for report
boundaries, labels and delivery schedules; do not use the host timezone. Store
the selected timezone and period definition with each report revision.

- Daily: local calendar day, from local midnight inclusive to next midnight
  exclusive.
- Weekly: Monday local midnight inclusive to next Monday exclusive, unless a
  user explicitly selects a different week start; record that choice.
- Monthly: first local day midnight inclusive to the next month's first local
  day exclusive.

Convert these boundaries to UTC instants for querying. Daylight-saving zones
may have 23/25-hour days; never assume all local days are 24 hours. A timezone
change affects future reports; it does not relabel an already generated report.
Any requested regeneration under a new timezone produces a new revision.

Source daily buckets may use a platform-specific timezone. Never silently
reinterpret those buckets as Tashkent days. Use compatible finer-grained data
when available; otherwise show the source window and mark boundary coverage
partial. Do not manufacture sub-day allocation from an aggregated daily bucket.

Every observation carries metric name/unit, source, source window/timezone,
observation time, revision and aggregation kind (period, lifetime, ratio or
point-in-time). Existing YouTube poll snapshots cover overlapping two-day
windows; summing daily rows overstates results. A monthly total requires an
authoritative matching-period query or non-overlapping compatible data. A
latest reading can be shown as a latest reading, never labeled monthly growth.

Missing is not zero. Unsupported, no consent, no data yet, stale, failed and
measured zero remain distinct. Do not average ratios without compatible
weights; subscriber growth needs comparable start/end evidence or an authorized
period delta. Cross-platform aggregates require compatible definitions and a
visible platform breakdown. Competitor private CTR/retention are never inferred
as measurements.

## Proposed logical records and contents

These are logical contracts, **not SQL or applied database changes**:

- Report definition: tenant/user, authorized channel set, cadence, timezone,
  week start, destination/dashboard preference and active revision.
- Report revision: immutable id, definition revision, local period and UTC
  boundaries, generated/as-of times, source windows and observation revisions,
  completeness, coverage and content digest; supersedes reference when revised.
- Coverage item: expected versus observed channels/videos/source windows,
  last successful collection, known gaps, freshness and limitation reason.
- Export request/artifact: tenant/actor, report revision, format, bounded
  resource budget, state, expiry and an authorization-checked download handle.

Report content should include channel growth where measurable, performance,
best videos under an explicit comparable ranking criterion, audience themes,
comment/draft/approved/sent/failed counts, customer credit/service charges,
evidence-cited AI recommendations and next-period strategy. Separate actual
measurements from recommendations and forecasts. A claim about improved results
requires comparable periods and a coverage statement, not merely a fluent model
summary. Learning may propose a strategy; it cannot change model weights or code.

Completeness is explicit (`provisional`, `complete_for_declared_sources`,
`partial`, `failed`), with coverage counts and unknown states. "Complete" only
means the declared sources/windows were collected; it is not a claim that a
platform exposes every desired metric. An empty authorized channel set is an
honest empty report, not zero performance.

## Late data, reconciliation and scheduling

A bounded scheduler enqueues one report per definition revision and local
period; retries use that idempotency identity. It does not call paid providers
just because the report was retried. Delay collection/finalization according to
documented platform latency; make the waiting state visible.

Late observations or platform corrections produce a new immutable report
revision, retaining the old one and recording changed sources and coverage.
Never silently rewrite a report that a user downloaded. Compare periods under
consistent revisions or explicitly disclose the mismatch. Export links point to
an exact revision. Deduplicate refresh/revision jobs and bound the revision
window and storage retention. No schedule is activated by approving P0 docs.

## Customer charges versus administrator costs

Customers see their own credits and service charges only. Internal provider
costs, markups, profitability and platform finance remain administrator-only.
Use existing billing quote/hold/capture/refund and cost-ledger records; reporting
is a read model, not a second financial ledger.

Identify the authoritative source and timestamp for each financial number.
Internal CPU/rendering/storage cost may not have a calibrated allocated cost
record; an external provider invoice may arrive late. Such costs are unknown or
estimated with an explicit method, never zero. Do not claim net profit from
customer credits minus an incomplete API-cost subset. Admin cost views need
documented reconciliation, currency/FX basis, refunds, taxes/fees and coverage
before any profit statement is considered measured. These are open acceptance
requirements, not evidence that accounting coverage exists today.

## Export and AI security

Follow [AI Security Policy](AI_SECURITY_POLICY.md). Server-side membership and resource ownership determine tenant/channel access;
model output or a supplied report ID cannot broaden scope. Recheck access when
requesting, generating and downloading an export, including after membership
revocation. Jobs use the narrow tool broker and global/org/channel kill checks.
Credentials and raw sensitive audience data never enter summaries or exports.

CSV uses a defined UTF-8 dialect with proper quoting, row/cell size caps and
formula-injection protection for untrusted text cells beginning with formula
markers (`=`, `+`, `-`, `@`) or leading control/whitespace tricks. Quoting alone
does not stop spreadsheet formulas. Encode text safely without changing trusted
numeric cells; document the protective representation and test target readers.

PDF rendering uses escaped data in a fixed trusted template inside a bounded,
unprivileged renderer. Disable JavaScript, arbitrary URLs, redirects, local-file
access and outbound network access; no user-provided HTML/CSS/paths. Embed only
validated assets resolved through a controlled asset broker. Enforce page,
image, memory, CPU and wall-time limits to prevent SSRF and resource exhaustion.

Artifacts live in tenant-scoped storage with short-lived authorized download
handles; no public bucket, arbitrary filename path or permanent bearer link.
Retain audit metadata without raw personal content or signed URLs. Revocation
and expiry must prevent access; do not rely solely on an unrevocable signed URL
when immediate membership revocation is required.

Any paid AI summary/export action uses the existing quote and immutable
SHA-256 canonical approval contract: exact report revision, tenant/channel set,
model/version, content/input digest, quoted credits, limits and expiry. A
material change requires reapproval. Report approval is not authorization to
publish, reply, spend elsewhere or enable recurring paid work.

## Acceptance and rollout

1. Validate daily/weekly/monthly boundaries in Tashkent and a DST zone, month
   transitions, timezone changes, source-timezone mismatch and overlapping
   snapshots. Assert missing never becomes measured zero.
2. Cover partial grants, stale collectors, unavailable CTR, absent monetary
   data, late corrections, revised periods and incomparable metric definitions.
3. Verify deterministic figures match canonical authorized sources. AI prose
   cites only those figures; no unsupported ranking, audience or profit claims.
4. Verify tenant separation and membership revocation at all export stages,
   including guessed IDs and expired handles. Test CSV formulas and PDF SSRF,
   local-file, script and resource-limit attacks.
5. Verify scheduler retries/duplicates do not duplicate reports or charges;
   kill switches stop new work and cleanly bound in-flight work.
6. After reviewed implementation approval, begin with manual read-only report
   previews behind a default-off flag. Then a single opted-in user's schedule,
   then PDF/CSV canaries. Rollback disables scheduling/exports without changing
   existing analytics, publishing, billing or editor behavior.
