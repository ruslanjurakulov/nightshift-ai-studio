# D1 Premium Visual Foundation review

This is the owner's separately authorized D1 implementation following the A–C
planning snapshot in PR #799. It is a presentation change, not authorization for
D2–D6, AI Brain P1, a merge, deployment or migration.

## Behavior and scope

- Shared signed-in surfaces use layered navy/violet, readable light surfaces,
  existing Onest typography, Lucide icons and the existing motion system.
- The existing, byte-identical Wordmark/N assets are reused, including the
  Canvas rail. Public landing, pricing, login and legal palettes stay scoped out.
- One top-right N opens the existing account panel at every width. The panel
  retains the private profile photo, email, fresh account/credit reads, connected
  accounts, language choices, independent Mobile/Desktop preference, settings,
  usage, credits, referral and sign-out actions. Compact Sun/Moon buttons use the
  existing theme resolver. The old sidebar account trigger is removed.
- Personal Studio links to the existing channel-scoped Studio route. No new
  Owner Command entry is exposed, including for operator fixtures. The narrower
  owner capability remains a separate D2 prerequisite; existing operator routing
  and server permissions are unchanged.
- Billing, credits, provider APIs, database, Film execution/persistence, MCP,
  authentication, secrets, server/deployment configuration and dependencies are
  unchanged. No paid operation was started.

## Review evidence

The unchanged PR #799 head `8a1aeb5905f62094cce9d37cd27ecf8884bcf586`
is the visual baseline. Both builds use the existing loopback fake Supabase
fixture with synthetic sessions/data, external browser HTTP blocked, and no
generation, payment or publishing action. Screenshots show actual Next.js pages,
not reconstructed mockups or production telemetry. Missing read endpoints remain
visible as unavailable/error states. This fixture is not an authorization/RLS test.

The capture matrix is 13 existing routes × 6 widths (375, 390, 430, 768, 1440,
1920) × light/dark. A separate account matrix exercises English, Russian and
Uzbek, keyboard opening/Tab/Escape/focus return, 44 px N/theme targets, theme
choices, reduced motion and axe accessibility checks.
Phone checks also exercise EN→RU, RU→UZ and UZ→EN preference changes. Menu
screenshots include its initial and scrolled action sections; its last action
is checked for occlusion and the panel must clear the bottom navigation.

The companion HTML gallery provides matched before/after screens and the
unchanged user-supplied design references. Original reference images are kept
in the private review bundle rather than added to the application repository.

At source freeze, the production build/type validation, full lint, dependency
advisory gate and public bundle check (35 entries) passed. The final focused
regression run passed 166 tests in 8 files, including all 22 new D1 tests and
the existing avatar/version, account, navigation, read-failure, concept and
review-link regressions. Thirteen desktop route samples had no capture findings;
the first 12 EN/RU/UZ account cases passed, with zero menu axe violations.
The invalid nested account banner was replaced with a normal identity row and
the account navigation now has its localized accessible name.

The complete 156-pair/72-account matrix and the hosted CI result are recorded
in the PR description/check run and supplied review bundle when complete.
Intermediate local full runs included resource-contention timeouts and an
unchanged wall-clock rate-limit test flake; the affected files passed the final
isolated regression run. Those intermediate runs are not represented as a
clean full-suite result. Hosted CI runs against the frozen feature commit.

React review found no new conditional hooks, duplicate account reads, public
app-dictionary import, provider waterfall or client/server-boundary change.

## Reproduce locally

Use the existing `tools/visual-qa/fake-supabase.mjs` fixture, Node 22,
Playwright/Chromium and the repository's exact dependency lockfile. Build the
unchanged baseline and D1 in separate worktrees, pointing both local builds at
the loopback fixture as documented in that fixture. These public test values
must never be used for a deployed build. No credentials or real database are needed.

```sh
node tools/visual-qa/premium-d1.mjs --base http://127.0.0.1:3491 --phase before --out /tmp/d1/before
node tools/visual-qa/premium-d1.mjs --base http://127.0.0.1:3492 --phase after --out /tmp/d1/after
node tools/visual-qa/premium-d1.mjs --base http://127.0.0.1:3492 --mode checks --out /tmp/d1/checks
node tools/visual-qa/premium-d1.mjs --base http://127.0.0.1:3492 --mode checks --role owner --out /tmp/d1/checks-owner
node tools/visual-qa/premium-d1-gallery.mjs /tmp/d1 /path/to/01_premium_mockups
```

The capture/check tools write JSON findings and return nonzero for findings;
pre-existing findings must be compared against the unchanged baseline rather
than silently discarded. Tests and evidence tools introduce no default CI job,
application dependency, production setting or backend endpoint.

## Limits and release boundary

Browser captures use Chromium viewport/touch emulation. They cover phone,
tablet and desktop sizes, not physical iPhones/Android tablets or Safari/WebKit.
Existing mockup-only finance, infrastructure and security dashboards are not
newly implemented under D1. Owner-in-Personal mode awaits D2 rather than a fake
role switch. Canvas/Timeline synchronization and pending PR #793 repairs remain
outside this change. A 4 px Timeline overflow at 768 px exists in both baseline
themes; D1 must not be described as a complete Timeline responsiveness repair.
The unchanged desktop command-center page also has two unnamed complementary
landmarks: baseline axe reports a moderate `landmark-unique` warning in both
themes. Account-menu accessibility and full-page accessibility findings are
reported separately; this change is not a claim of whole-application WCAG
certification.

Before release: owner screen review, separately authorized integration/merge,
and device/browser verification remain necessary. There is no deployment,
database migration or automatic activation in this PR.

## Committed screen comparison samples

These unchanged Chromium JPEGs use synthetic fixtures. Each pair is 1440 px,
dark, captured from the unchanged baseline and the final D1 production build.
The private review gallery adds every width/theme and original mockup references.

| Existing screen | Before | D1 |
|---|---|---|
| 01-executive | [Before](screenshots/d1-before-01-executive-1440-dark.jpg) | [After](screenshots/d1-after-01-executive-1440-dark.jpg) |
| 02-api-models | [Before](screenshots/d1-before-02-api-models-1440-dark.jpg) | [After](screenshots/d1-after-02-api-models-1440-dark.jpg) |
| 03-customers | [Before](screenshots/d1-before-03-customers-1440-dark.jpg) | [After](screenshots/d1-after-03-customers-1440-dark.jpg) |
| 04-plans-credits | [Before](screenshots/d1-before-04-plans-credits-1440-dark.jpg) | [After](screenshots/d1-after-04-plans-credits-1440-dark.jpg) |
| 05-cost-finance | [Before](screenshots/d1-before-05-cost-finance-1440-dark.jpg) | [After](screenshots/d1-after-05-cost-finance-1440-dark.jpg) |
| 06-infrastructure | [Before](screenshots/d1-before-06-infrastructure-1440-dark.jpg) | [After](screenshots/d1-after-06-infrastructure-1440-dark.jpg) |
| 07-security | [Before](screenshots/d1-before-07-security-1440-dark.jpg) | [After](screenshots/d1-after-07-security-1440-dark.jpg) |
| 08-canvas | [Before](screenshots/d1-before-08-canvas-1440-dark.jpg) | [After](screenshots/d1-after-08-canvas-1440-dark.jpg) |
| 09-customer-home | [Before](screenshots/d1-before-09-customer-home-1440-dark.jpg) | [After](screenshots/d1-after-09-customer-home-1440-dark.jpg) |
| 10-composer | [Before](screenshots/d1-before-10-composer-1440-dark.jpg) | [After](screenshots/d1-after-10-composer-1440-dark.jpg) |
| 11-timeline | [Before](screenshots/d1-before-11-timeline-1440-dark.jpg) | [After](screenshots/d1-after-11-timeline-1440-dark.jpg) |
| 12-account | [Before](screenshots/d1-before-12-account-1440-dark.jpg) | [After](screenshots/d1-after-12-account-1440-dark.jpg) |
| 13-public-pricing | [Before](screenshots/d1-before-13-public-pricing-1440-dark.jpg) | [After](screenshots/d1-after-13-public-pricing-1440-dark.jpg) |

Account: [Light](screenshots/menu-390-en-light.jpg), [Dark](screenshots/menu-390-en-dark.jpg), [Light actions](screenshots/menu-actions-390-en-light.jpg), [Dark actions](screenshots/menu-actions-390-en-dark.jpg).
