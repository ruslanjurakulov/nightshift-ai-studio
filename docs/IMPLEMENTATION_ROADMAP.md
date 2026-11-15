# Nightshift AI Brain — implementation roadmap v1.0

Status: **P0 documentation complete for review; implementation not authorized**.
Date: 2026-11-15, Asia/Tashkent. Baseline: `f985b3afd371c0677357670da436ef2074fdb036`.
This roadmap describes future changes; it changes no code, database, feature switch,
server configuration or production service. Every implementation PR below requires a
new authorization scope. Do not treat the document as an executable operations runbook.

## 1. Reading order and precedence

Read [architecture](AI_BRAIN_ARCHITECTURE.md), [agent registry](AI_AGENT_REGISTRY.md),
[security](AI_SECURITY_POLICY.md), [model/resource/cost benchmark](AI_MODEL_BENCHMARK.md),
[memory](AI_MEMORY_ARCHITECTURE.md), [channel intelligence](CHANNEL_INTELLIGENCE.md),
[audience](AUDIENCE_INTELLIGENCE.md), and [reporting](REPORTING_INTELLIGENCE.md).
The [unfinished-work audit](CLAUDE_UNFINISHED_WORK_AUDIT.md) is an additional evidence
register requested by the owner, not a tenth runtime subsystem.

Reuse the existing [Studio Planner design](studio/PLANNER.md) and [Film Studio](FILM_STUDIO.md).
Do not implement a second planner gate, executor, billing ledger, timeline or comments inbox.
The historical [Creative OS plan](CREATIVE_OS_PLAN.md), [Video OS roadmap](ROADMAP_VIDEO_OS.md)
and superseded [gap analysis](product/GAP_ANALYSIS.md) are context, not current missing-feature lists.
Phase numbers in those documents are not the Brain phases below.

## 2. P0 risk register and concrete remediation work

All live status is unverified. A risk being specified here is **not fixed**. Repository
evidence and open-PR claims need verification against the exact implementation base.

| ID / severity | Evidence and risk | Concrete future implementation package | Blocking acceptance evidence |
| --- | --- | --- | --- |
| RES-01 / high | 48 GiB pipeline cap plus other services; nominal 64 GB CPU-only host; no i7 benchmark | Measure actual usable RAM and service peaks in an owner-approved window; establish one heavy-work lane, admission control and reviewed hard memory/CPU/PID limits before loading a resident LLM | RSS and cgroup/page-cache peaks, no OOM/swap thrash, bounded queue, web responsiveness, overload refusal; no production sizing from dev-container PSS |
| SEC-01 / high | 0107 guarded owner RPCs are gated; legacy grant/direct price/roster paths remain in source | Inventory every direct/API/MCP/worker caller; move callers to audited/capped RPCs; then a separate forward migration closes legacy grants/writes and enforces fresh AAL2 where required | Direct PostgREST bypass denied, concurrent grant caps hold, last-owner protected, tested break-glass; no rollback that reopens bypass silently |
| P0-BILL-01 / high | [PR 787](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/787) reports sandbox deliveries minting usable credits | Review existing Paddle sandbox allowlist patch rather than rebuild; separate test workspaces/environment provenance at checkout and webhook effect boundary | Valid sandbox signature on a non-test org creates no credits/API balance/subscription entitlements; duplicate events remain idempotent; Dodo parity checked |
| P0-BILL-02 / high | [PR 750](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/750) reports concept-thumbnail holds omitting generated images | Reuse its database/worker pricing alignment; coordinate current function-body guards and pending jobs before any later authorized deployment | UI, direct DB, series, API and MCP quotes cover the same approved units; worker cannot buy outside the open hold; settle never exceeds hold |
| P0-BILL-03 / high platform cost exposure | Failed jobs can release retail holds after a provider incurs cost; [PR 786](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/786) adds abuse cap | Review the failure-cap patch and distinguish customer errors from outages; add independent platform cost reservations in SEC-04, including exempt/free work | Repeated/refused calls cannot exhaust unbounded shared provider credit; outage failures don't unfairly consume customer limits; concurrent admissions cannot overshoot |
| SEC-02 / high | Existing workers carry credentials and service role; unsuitable as model sandbox | Dedicated secrets-free planner/inference boundary, deterministic typed broker, narrow identities and egress; no shared worker env/production mounts | Secret sentinel inaccessible, cross-tenant denied, unlisted tools/SQL/shell/SSH/Docker/deploy denied, capability replay/forgery denied |
| SEC-03 / high | Per-feature switches are not a central dispatch stop | Global/org/channel stop records with monotonic fence generation; check at admission and each actual side-effect dispatch; reserve reconciliation capacity | Race/partition tests deny new send permits after acknowledged stop; no claim of recalling already-sent HTTP; outcome-unknown reconciled once |
| SEC-04 / high | Site/API balance is not a platform provider-cost cap; budget module alone is insufficient | Atomic retail holds plus conservative platform cost exposure, daily/monthly caps and bounded free/local CPU/tokens; consistent locks and expiry | Exempt orgs/free planning/retries still capped; missing price not zero; inflight liabilities retained across rollover and crash |
| SEC-05 / high | Existing storyboard/film quotes are partial binding patterns, not complete Brain manifest approval | Map existing Studio Planner proposal to immutable canonical SHA-256 manifests and exact human approval; bind quote, versions, actions, rights and parent payer | Semantic mutation/replay/expiry/membership/model tests; no child double billing; generation approval never authorizes publishing or replies |
| DATA-01 / high | New memory/reports could cross user or org scopes despite existing RLS | Scope identity outside the model; preserve user-private memory; retrieval filters and foreign-key ownership; sanitized read projections | Two-tenant/two-user tests, deletion/consent revocation, platform-admin identity absent from Brain |
| DATA-02 / medium | CTR capability and metric windows differ by platform; missing admin costs | Official metric capability fixtures and period-aware snapshots; private cost ledger coverage/reconciliation | Unsupported metrics unavailable, missing != zero; no summing overlapping snapshots; profit unknown when cost coverage incomplete |
| AUD-01 / high | Third-party comments/research can inject instructions; automatic replies not yet safe | Tool-free external-text analysis, output checks, escalation, exact-text human approval; narrow future default-off rules | Injection cannot gain a tool or exfiltrate, complaint/privacy cases escalated, send destination/body fixed and idempotent |
| DEV-01 / high | Developer Auditor must not inherit production privileges | Secret-scrubbed immutable source snapshot, isolated read-only analysis role | No write token/secrets/runtime tenant data/server access; every edit/deploy request denied |

SEC-01–05 details and transaction/dispatch caveats are in [AI_SECURITY_POLICY](AI_SECURITY_POLICY.md).
RES-01's proposed caps, measurements and cost worksheet are in [AI_MODEL_BENCHMARK](AI_MODEL_BENCHMARK.md).

## 3. Ordered reviewable work packages after owner authorization

| Order / package | Depends on | Changes to prepare in a later branch | Verification / stop condition |
| --- | --- | --- | --- |
| W0 current-base reconciliation | Owner permits implementation planning to proceed | Re-read current main and open PRs; map changed functions/migration allocations/callers and actual rollout state through approved access | Stop if prerequisites or deployed schema are unknown; do not choose migration numbers from this document |
| W1 billing/security closure | W0; coordinate PR 787/750/786 | Reuse existing patches; owner RPC caller migration followed by legacy API closure; preserve 0167/0168/0172 refund/hold recovery | Isolated real Postgres negative/concurrency tests and upgrade-path tests; no prod writes during validation |
| W2 resource experiment | Approved nonproduction host/window, artifact/license review, $ cap | Bounded single-candidate experiment on matching i7 hardware; no app integration required | Stop before download/load if RAM/storage/license budget not satisfied; report failures as measurements |
| W3 broker and dispatch control | W0; W1 before privileged release | Agent allowlists, trusted scope, audit, kill fences, atomic cost cap and leases | No external side effects enabled; adversarial tests pass before any paid path |
| W4 provider-agnostic inference | W2/W3 interfaces | Compatibility adapter around current Gemini, then qualified local adapter, strict schemas, one queue, deadlines | Existing behavior preserved; local model cannot silently become API fallback; no paid/media/publish tool |
| W5 plan/approval foundation | W3; Studio Planner design alignment | Map template/catalog/gate/executor concepts and existing film/pipeline versions; approve canonicalization/payer/partial-charge contract | Owner reviews exact plan and retail quote; SQL/TS/Python fixtures agree; no approval-as-boolean shortcuts |
| W6 read-only pilot | W1–W5 gates relevant to the enabled scope, owner decision | Research/script/director draft roles only, sample tenants, disabled by default | No provider spend except explicitly budgeted LLM test route; no publish/reply effects; rollback disables new admissions |
| W7 paid Idea-to-Video | Separate P2 authorization, W5/W6 | Reuse Film or existing storyboard workflow and existing jobs/assets/editor; finish missing Film worker only once | End-to-end quote/approval/hold/provider/result/settlement/editor path and crash cases pass |

Do not serialize unrelated documentation work behind deployment. Conversely, a local
read-only prototype does not justify opening paid effects while billing/security work is
pending. Existing capabilities outside the Brain retain their behavior until their own
reviewed changes land. No merged migration is edited; coordinated forward migrations and
explicit deployment approval are mandatory for future database/configuration work.

## 4. Brain P0–P5 gates

| Phase | Deliverable | Required exit / next-step authorization |
| --- | --- | --- |
| P0: technical specification | These nine docs plus unfinished-work audit; evidence/status/risk/dependency registers | Docs-only diff reviewed, no unsupported live/benchmark claims; owner receives cost/resource/security conclusion. P1 is not implicitly authorized |
| P1: foundation and read-only pilot | W0–W6 as separately scoped PRs: LLM contract, queue, registry, policy, stop/cap controls, schema validation | Qualified benchmark or an explicit no-local-model decision; secret/tenant/tool tests pass; supervised read-only pilot approved |
| P2: approved Idea-to-Video | W7, immutable manifest, exact models/quotes, existing editor/Film/pipeline integration | Changed plan invalidates approval; all paid units held; unavailable model fails; no duplicate purchase/settlement |
| P3: channel and memory | Scoped supported analytics, evidence-based strategy, approved memory retrieval | Platform permissions verified; source-window/coverage semantics correct; cross-user/org tests pass |
| P4: audience and reporting | Human escalation, manual/assisted inbox, daily/weekly/monthly report and safe PDF/CSV exports | Automatic replies remain off unless separately authorized; customer exports reveal no costs/margin/private data |
| P5: measured optimization and rollout | Qualified local audio/routing, staged traffic, capacity and kill drills, cost reconciliation | Measured quality and SLOs, license/consent approval, no silent fallback, bounded financial exposure; explicit production release approval |

Higgsfield, Krea, BigMotion, Buzzy, Fliki and DeeVid remain benchmarks. Prefer the original
model makers' official APIs. Do not integrate an aggregator because its demo is convenient.
Keep the editor's real features; parity claims require an assessed feature/quality matrix.

## 5. Resource and expenditure decisions to review before P1

1. Confirm hardware identity and actual usable memory; nominal 64 GB may mean about 59.6
   GiB before OS reservations. Confirm disk RAID/free space; no assumed 1 TB/8 TB usable.
2. Approve a resource experiment envelope, initially one inference request and no concurrent
   CPU-heavy render/STT; actual hard limits need a later configuration change.
3. Select benchmark candidates/artifacts and an offline fixture corpus; do not select a winner.
4. Approve task-specific quality/latency SLOs. Proposed numbers in the benchmark doc are
   decision targets, not measurements or current service guarantees.
5. Set separate engineering/test budget and any external API comparison budget. Current P0
   external paid-call budget is $0. An existing server does not make local capacity free.
6. Decide P1 task classes and initial pilot tenants. Initial Brain approval is interactive
   owner/admin-only; API/MCP approval delegation needs a separate reviewed design.

The economic worksheet uses actual input/output/reasoning usage, retry rate and accepted
results, plus attributable hosting, displaced render capacity, storage and operations.
No current vendor tariff or guaranteed monthly savings is asserted. Keep ElevenLabs premium
and the recorded external Scribe decision; VoiceStudio's NC default weights remain blocked.

## 6. Verification scope for this documentation change

Verify all ten requested/dedicated Markdown files exist; the nine required names are exact.
Check local Markdown links, fenced blocks, whitespace and consistency of source baseline,
permissions, phase names, payers, kill semantics, price privacy and approval invalidation.
Confirm the diff against `f985b3af` contains only those docs, and the original checkout stays
clean at its original commit. Run independent architecture/security review of the package.

Application tests/builds, SQL, container builds, live diagnostics, model downloads and
benchmarks are not part of P0 documentation verification. Do not report them as passed.
If a docs draft PR is published, keep it draft; no merge, deployment or switch activation.

## 7. Completion and reopening rules

P0 is reviewable when architecture, reuse, resource/cost uncertainty and each P0 risk have
a concrete work package and acceptance gate. It is not production-ready. Record owner
decisions and their scope before P1; an architecture approval alone does not approve
benchmark spend, production access or rollout. New remote commits invalidate only affected
evidence, not the whole package: re-audit changed dependencies rather than restarting work.
