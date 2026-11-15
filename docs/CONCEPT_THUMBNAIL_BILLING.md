# Concept thumbnail billing: PR 750 follow-up

Status: implementation on `codex/p0-750-billing`, not merged or deployed. The
base is PR 750 head `ae4050ac7bd048064574261cae41a61bce31670b`. This change
does not enable a model, seed a tariff, change a publishing gate or touch production.

## One operation, its existing payer

Site-funded runs keep `credit_reservations` and the existing credit settlement.
Their floor is the rounded maximum of job minimum and positive per-minute base,
plus up to four concept images at `image_generations`. A valid priced duration
and finite positive `video_minute` rate are required. Historical cost estimates
remain available for analytics but cannot authorize an unpriced paid run.

API-funded runs keep `api_holds`, `api_accounts` and the API USD-cent ledger.
`api_prices.concept_thumbnail_image` is the independent retail cents per image;
the API hold is `api_video_price(seconds) + ceil(4 * image_cents)`. No site-credit
conversion is used and no guessed rate is seeded. A missing or nonfinite image
tariff returns `pricing_unavailable` before a hold/job is created. Explicit zero
is a configured image tariff; the per-minute video base must still be positive.
The existing balance, monthly/key limits and concurrency checks include the total.

Synthetic example only: 60 seconds at 120 cents/minute plus four images at
2.125 cents each holds 129 cents. These are test numbers, not published prices.

API holds record the thumbnail mode priced at creation. The checked claim checks
ownership/job binding, current valid rates, sufficient amount, matching frozen mode
and expiry, then returns trusted terms for the worker. Legacy concept holds without
frozen terms fail before provider spend. A mode change between claim and the
pipeline's independent channel load also fails, in either direction. No model or
thumbnail mode is silently substituted. Customer/API holds still settle once in
their existing domain; failures release under the existing rules. No child hold
or second ledger is created.

## Migration and rollback boundaries

0178 is additive and follows unmerged 0175; no merged migration is edited.
It adds mode metadata to API holds, shared pricing validation, a final direct-queue
guard and checked claims. Changed existing bodies have before/after drift guards;
an unexpected body aborts the transaction. Historical migration replay tests remove
0178 before testing older bodies and restore the current layer afterward.

A future authorized rollout must apply the reviewed database changes as one
transaction and coordinate worker replacement: stop old workers before admitting
new API concept work. Only the updated worker forwards checked API terms to the
pipeline. Review pending legacy jobs and the live source hashes first. Configure
the API image tariff through existing authorized administration only after its
commercial price is chosen; until then concept API creation fails closed. This
document performs none of those operations.

Expiry uses the existing release/recovery path under account locks: site unstarted
holds expire after three hours, site started holds after 24 hours, and API holds
after their existing 24-hour windows. Pending purchase/top-up refunds are collected
on release exactly once. Refund/grant-reversal functions and payer ledgers are not
replaced. Current-main recovery/migration integration requires the separate
coordinator's compatibility check.

`sql/rollback_0178_api_concept_thumbnail_holds.sql` is an explicit owner rollback,
not an automatic action. It restores earlier pricing/claim bodies and therefore
reopens their known gaps; it retains frozen metadata and changes no financial rows
or configured prices. Pause all paid admissions and stop affected workers before
considering rollback; never couple it automatically to an application rollback. No rollback
or deployment is authorized by merging a source change alone.

## Verification

Regression suites use synthetic prices/identities, disposable Postgres and mocked
provider execution. They cover independent currencies, absent/zero/NaN prices,
normalization, direct insertion, old/underfunded/changed-mode holds, idempotency,
scope, expiry, pending refund collection and guarded replay/rollback. They do not
call a paid provider or establish live deployment readiness. Security records are
`BR-750-01` through `BR-750-04` in `security/LEDGER.md`.
