# P0 security remediation — integration evidence

Status: local verification record; no production release or AI Brain P1 authorization.
Verified: 2026-11-16 (Asia/Tashkent).

## Review units

| Original PR | Separate repair PR | Repair branch | Scope |
| --- | --- | --- | --- |
| [787](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/787) | [796](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/796) | `codex/p0-787-recovery` | Terminal-event recovery documentation and replay/signature regression tests |
| [750](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/750) | [798](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/798) | `codex/p0-750-billing` | Fully funded API/site generation, base-price checks, normalization, expiry and regression coverage |
| [786](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/786) | [797](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/797) | `codex/p0-786-history` | Correct first-main-integration history and fail-closed Git evidence checks |

Repair PRs target the original feature branches so their diffs contain only the
remediation. Original PRs, `main`, production configuration and deployed services
were not modified. No PR was merged. The private integration branch is a local
test checkout, not a release branch or instruction to merge.

## Source and test environments

- Current-main baseline: `f985b3afd371c0677357670da436ef2074fdb036`.
- Recovery repair: `e5eff7024270648fe51f1a17f35c72dcf7b4e4b5`.
- History repair: `7360c242efe38fb9f693f10e558923e883242a75`.
- Pricing/authorization runtime and fixture repair: `cc7fe05e72eb6be2d591f8daf76ab232d837d213`.
- Combined frozen test tree: `5631813943705066cae7f560641fa75f6c0864a3`.
- Node 22 and lockfile dependencies; Python 3.11; isolated PostgreSQL 16 containers
  on loopback, synthetic actors/balances, no production connections or credentials.
- The security harness emulates Supabase primitives with its existing bootstrap.
  Passing it does not prove hosted Supabase executor/Auth/Storage equivalence.
- No model download, paid provider generation, real payment, deploy or migration
  on a hosted/production database was performed. Only the new repository migration
  was applied in disposable test databases.

## Completed checks

| Check | Result |
| --- | --- |
| Recovery-focused billing handlers / Python entry checks | 139 Vitest and 14 Python tests passed |
| Recovery full frontend | 635 files / 15,094 tests passed; typecheck, lint and build passed |
| History Git-DAG suite | 29 passed, including stale refs, divergent/ambiguous histories, detached CI and malformed evidence |
| History migration discovery / dedicated DB regression | 1,367 and 62 passed respectively |
| Pricing focused Python / TypeScript | 133 and 142 passed respectively |
| Pricing full frontend | 622 files / 14,884 tests passed; typecheck, lint and build passed |
| Pricing standalone migration discovery | 1,279 passed |
| New pricing and callable-catalog/trigger permissions | 62 passed |
| Affected billing/replay/RLS files together | 366 passed |
| Funded voice authorization fixtures / MCP historical replay | 290 and 44 passed respectively; original authorization assertions retained |
| Combined current-main migration application | All migration files present in the combined tree applied through 0178 |
| Combined migration discovery / billing and queue units | 1,393 and 201 passed respectively |
| Combined frontend typecheck and lint | Passed |
| Final combined full security suite | **7,685 passed, one conditionally skipped, no failures** (596.21 seconds) |

Counts overlap between targeted suites and are not summed. The first broad
integration run found 35 failures (7,647 passed, one skipped). Those exposed
historical-layer teardown/restoration, improperly funded voice fixtures, a trigger
catalog mismatch and authorization-error ordering. They were corrected without
removing drift guards, weakening RLS assertions or admitting underfunded jobs.
The fresh full-suite result above is the release-review evidence, not that first run.
The single skip is `test_sec_creative_credits.py:182`: its no-registry case is
inapplicable because migration 0035 and the registry are present. It is not a
skipped remediation regression. Independent architecture/security reviews found
no remaining high/medium implementation findings in the reviewed repair scope.

## Conflict and migration reconciliation

The local combined checkout preserved both sides of these conflicts:

- `modules/render_error.py`: both `CredentialsMissing` and `HeldTermsRefused` mappings.
- `docs/MIGRATIONS.md`: all separate migration notes and dependencies.
- `tests/test_ads_factory_migration.py`, `test_brand_scan_migration.py` and
  `test_series_plan_caps_migration.py`: union of reviewed numbers; 0175 remains
  in the explicit read-only `reads_plans` classification where applicable.
- `tests/security/sec_expectations.py`: Film 0171, Rights 0174, Cap 0177 and
  internal 0178 functions; trigger functions remain outside the callable catalog.
- `tests/security/sec_db.py`: newer layers removed before historical replay and
  restored through real guarded migrations afterward.
- `docs/security/LEDGER.md`: canonical row format and current-main counts retained;
  unmerged remedies are not represented as merged or deployed closure.

0177 and 0178 replace different runtime functions. 0178 requires 0175 and must
not be applied before it. The combined tree does not include the outstanding
0176 voice PR: coordinate numbering/order before release. If 0178 lands first,
later deferred work needs a reviewed forward number, not a backdated migration
or an edit to an applied file. Recheck current heads and live body hashes through
separately approved access before any future deployment.

## Remaining release boundaries

The API image tariff is intentionally unseeded. Until the owner configures the
explicit API-cent price, concept API requests fail closed. Site/API balances
remain separate. Existing queued holds need a reviewed rollout plan; stop old
workers and coordinate the new worker with 0178. No rollout was performed here.

Rollback is explicit owner action and restores known older gaps; it is not a
safe automatic fallback. Live schema, permissions, prices and worker versions
remain unverified. Complete Git history and a verified main ref remain required
for history checks. Universal platform-cost caps, central AI Brain kill fencing,
local LLM benchmarks and the P1 pilot are outside these three remediations and
remain subject to separate implementation/release authorization.
