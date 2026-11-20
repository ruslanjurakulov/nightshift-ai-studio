# AI Brain Security Policy — P0 Specification

Status: **proposed documentation; no security control is implemented or enabled by this document**.

Audit baseline: repository commit `f985b3afd371c0677357670da436ef2074fdb036` (2026-11-15), including migrations through 0174. The earlier read-only audit at `e02c884a309dbcdfee3678bc2a13a3a014afb38d` is historical context only; remediation statements below were rechecked against this newer baseline. Production migration application, feature flags, credentials, host configuration and runtime enforcement were not inspected. Source presence is not evidence that a production control is enabled. P0 is documentation only; the implementation PRs below require separate owner authorization.

## Existing controls to preserve

The owner's rules in [CLAUDE.md](../CLAUDE.md) take precedence. Preserve private uploads, the existing publish gate, explicit channel switches, exact-cut approval, no silent provider substitution, and the browser's intent-only role. The Brain may request an action through a broker; it cannot bypass the existing worker, approval, credit or provider guards.

| Existing source | Observed capability | Limit of the observation |
|---|---|---|
| [Organization role checks](../command-center/lib/auth/org-roles.ts) and [organization migration](../supabase/migrations/0018_organizations.sql) | User/org/channel authorization and scoped RLS | Platform admins intentionally have broad organization access; do not give that identity to the Brain. Live policies are unverified. |
| [Credit ledger](../supabase/migrations/0020_credits.sql) and [creative jobs](../supabase/migrations/0036_creative_jobs.sql) | Holds, bounded capture, release, account locking, request idempotency | Existing account exemptions and unknown-cost behavior are not sufficient Brain platform-cost caps. |
| [Margin privacy](../supabase/migrations/0084_margin_private.sql) and [cost mirroring](../modules/supabase_sync.py) | Retail-only member prices; customer channel mirror omits provider USD | New reports and tools must preserve this split. Do not infer production migration state. |
| [Owner safety](../supabase/migrations/0107_owner_safety.sql) and [owner RPC switch](../command-center/lib/server/owner-rpc.ts) | Audited, capped owner operations and a second-factor gate are available | App routing is behind a default-off flag. Legacy direct paths remain in the audited source. |
| [Publish approval](../supabase/migrations/0112_approve_video_publish.sql), [visibility requests](../supabase/migrations/0116_visibility_requests.sql), [publish documentation](APPROVE_PUBLISH_1B.md) | Exact-cut approval, expiry, real membership, repeated dispatch checks and provider readback | A Brain generation-plan approval must not replace or manufacture a publish approval. |
| [Film Studio](FILM_STUDIO.md), [film money](../supabase/migrations/0171_films_money.sql) | Version-bound stored quotes, 30-minute expiry, repricing, one segment hold, concurrency limits, per-film retail cap and a Film Studio switch | Reuse these controls. Quote IDs use MD5 for request consistency; they are not the proposed SHA-256 Brain security approval contract. Default film cap is absent. This switch is not a global/org/channel Brain stop. |
| [Purchase recovery](../supabase/migrations/0167_refund_hold_recovery.sql), [API recovery](../supabase/migrations/0168_api_refund_hold_recovery.sql), [grant reversal recovery](../supabase/migrations/0172_grant_reversal_hold_recovery.sql) | Recover refundable/reversed credits when existing holds release; captured portions follow existing settlement | Preserve recovery order and liabilities. Do not refund or release uncertain in-flight work as a shortcut. |
| [Deployment compose](../deploy/docker-compose.yml) and [worker image](../Dockerfile.worker) | Non-root workers, dropped capabilities, resource limits and separate worker environment | These workers have privileged credentials. They are not the Brain sandbox. |

Canonical historical findings remain in [security ledger](security/LEDGER.md); operational MFA instructions remain in [ADMIN_MFA.md](security/ADMIN_MFA.md). This document defines the additional P0 design and remediation gates rather than duplicating their incident histories.

## Trust boundaries and default behavior

All Brain capabilities default to **no external effect**. A model response is untrusted data, including structured tool calls. Prompt text, role descriptions and model refusals are not authorization controls. Deterministic backend code must authorize every action before an executor receives it.

The inference service and Brain orchestrator must not receive provider credentials, Supabase service-role credentials, database owner credentials, raw OAuth tokens, signing keys or unrestricted filesystem access. An internal inference endpoint is reachable only from the orchestrator; inference does not reach the internet or the data plane. The orchestrator reaches narrowly exposed retrieval and capability-broker endpoints, not the database, provider APIs or deployment systems directly.

A separate capability broker authenticates the real requester and derives organization, user and channel scope from trusted server state. It rejects model-supplied identity substitutions. It grants short-lived, single-purpose capabilities bound to actor, organization, channel, run, tool, immutable input digest, approved plan hash, policy version, budget reservation, expiry and replay key. A capability is not a provider secret. Its audience is one executor; it cannot authorize another tool or organization. Executors validate signature/audience and consult revocation/fence state immediately before dispatch; a valid signature alone does not imply current permission. Never expose capability signing keys to inference or include credentials in model context, logs or error messages.

Use strict schemas, bounded input/output sizes, explicit enumerations and tool allowlists. No generic shell, SQL, HTTP-fetch, filesystem-write or unrestricted MCP tool may be exposed. Outbound retrieval uses a separate constrained fetch service with approved destinations and protection against private-address/redirect access. Provider errors are mapped to safe customer errors; raw vendor responses and credential material stay out of prompts.

For all Brain components: non-root user, read-only root filesystem, writable bounded scratch only, dropped Linux capabilities, no-new-privileges, CPU/RAM/PID/time limits, internal network segmentation, explicit egress, audit logging and rate limits. No host sockets, Docker socket, host credential directories, writable source checkout or production data volume mounts.

### Forbidden authority

The Brain cannot use SSH, root, Docker control, production-code writes, schema changes, migrations, deployment commands, main-branch pushes, API-key reads or unrestricted financial operations. Runtime policy cannot grant these through a prompt. The System Monitor receives redacted metrics and safe diagnostic summaries, never environment dumps, raw logs containing secrets or secret-store access.

The Developer Auditor is a separate read-only service over an approved source snapshot, stripped of secrets and disconnected from production. It may report findings and proposals. Owner-authorized code changes occur only in an isolated test branch/environment; production deployment requires a distinct human approval outside the Brain. The Publisher cannot create, approve, extend or impersonate human approvals; it can only consume existing permitted requests through the established publish path.

## P0 remediation register

### SEC-01 — Close legacy privileged database paths

**Observed:** [0107 owner safety](../supabase/migrations/0107_owner_safety.sql) adds safer operations; [owner-rpc.ts](../command-center/lib/server/owner-rpc.ts) routes the app conditionally. Source re-audit through migration 0174 did not find closure of every legacy direct grant, price or roster path. Existing ledger findings BR-S-026/028/029 describe related risk; their rollout notes are historical and must be compared with current callers.

**Required implementation sequence:**

1. Inventory every UI, server, CLI, public API and automation caller of credit grants, price changes and roster changes, and the grants/policies that permit them. Record needed roles and authentication assurance.
2. Migrate legitimate callers to the audited RPC interfaces, including reason, request idempotency, transaction locks, caps and role checks. Preserve customer read behavior and retail pricing. Verify real caller coverage before changing grants.
3. Deploy caller migration with monitored failures and rollback instructions. Only then introduce a new forward migration to revoke legacy authenticated execute/write paths and restrict internal helpers; do not edit applied historical migrations.
4. Require fresh AAL2 for privileged money, price, roster and security-gate mutations at the database boundary, not only in middleware. Review user binding, role freshness and revoked-session behavior. Granting the service role to the Brain is forbidden and is not a solution to caller failures.
5. Preserve an owner-controlled, documented break-glass procedure using a separate administrative session. Require off-platform owner authentication, record the reason/time/actor, alert on its use and restore enforcement afterward. The Brain cannot invoke or discover break-glass credentials.

**Acceptance gate:** direct authenticated REST/RPC attempts to legacy grant/price/roster paths fail even with an AAL1 platform-admin token; valid migrated AAL2 flows succeed; stale assurance, self-demotion, last-owner removal, duplicate grant and concurrent cap violations are refused. Exercise recovery without accidentally locking out every owner. Existing reads and customer scopes remain intact. These are planned acceptance tests, not tests run during P0.

### SEC-02 — Enforce service and capability isolation

**Required:** separate inference, orchestrator, broker, retrieval and side-effect executors. Only the broker/executor boundary can resolve credential references. Prefer scoped database roles/RPC interfaces with explicit per-tool grants; a service-role key is not an acceptable Brain identity. If a legacy executor retains broad credentials during transition, isolate it behind a narrow authenticated interface, document the residual blast radius and schedule least-privilege replacement before broad rollout.

Retrieval must apply trusted org/user/channel scope before any result enters context. Scope cache entries, checkpoints, vector indexes, object links, traces and exports as well as SQL rows. External comments/documents are marked untrusted; they cannot override policy, supply tools or promote themselves to trusted memory. Memory proposals require provenance and an authorized promotion path.

**Acceptance gate:** cross-tenant IDs, cache keys and vector filters disclose no records; forged/expired/wrong-audience/replayed capabilities fail; inference cannot reach provider/DB/metadata endpoints; containers cannot read host secrets or write source. System Monitor and Developer Auditor remain read-only under hostile input. Demonstrate network denial and permission denial, not only absence of a UI button.

### SEC-03 — Provide fail-closed emergency stops and dispatch fencing

**Observed:** activity-specific stops already exist, including marketing and Film Studio. No universal Brain dispatch fence was identified. Reuse proven patterns without treating those switches as universal coverage.

**Required:** global, organization and channel stop states, plus a monotonic execution-fence revision. Any active parent stop denies child work. Missing/unreadable policy state, stale fence, failed authorization or unavailable broker denies new external effects. Only authorized humans/operators can change stop state; the model cannot clear it. Stops must be checked at admission, queue claim and immediately before executor dispatch.

A queue check is insufficient: stop activation and dispatch authorization must serialize on the same authoritative fence/lock boundary. The executor's final authorization consumes a one-use dispatch record atomically with current fence/policy/approval/budget checks. Define the linearization point: a dispatch authorized before stop may already be in flight; a dispatch authorized after stop is forbidden. A stop cannot promise to retract a packet already sent. Use a controlled executor/egress boundary so a model or worker cannot retain a reusable permission after the check. If durable fence verification is unavailable, do not dispatch.

On stop: stop new claims/dispatches; retain submitted provider task IDs, reservation references and audit state. Cancel already-sent operations only when the provider supports safe cancellation; otherwise poll/read back under a narrowly scoped reconciliation capability. Reconciliation cannot create another paid job, publish or reply. Unknown provider outcomes remain explicitly unknown until evidence resolves them. Keep unresolved **platform-cost exposure reservations** counted independently: a stop, timeout or customer refund does not prove the vendor charged nothing. Customer credit holds follow the existing domain settlement policy and bounded resolution deadlines; current creative jobs can release the customer hold after an interrupted/uncertain submit, leaving any vendor cost with Nightshift. Do not lock customer credits indefinitely or change that treatment through this specification. Reconcile and apply existing customer settlement/refund rules exactly once; never claim an external cancellation or vendor refund without readback. Re-enabling does not revive expired approvals or old capabilities.

**Acceptance gate:** race stop activation against claims and final dispatch across multiple workers; verify no new send permit is authorized after the stop linearization point. Previously authorized permits and already-sent calls may remain in flight and must be accounted for and reconciled; do not claim the stop can atomically recall external HTTP. Cover broker/database outage, queued and submitted states, restart, duplicate reconciliation, provider noncancellation and unknown outcomes. Audit the actor, scope, revision and effective time; verify no false success, duplicate send or unjustified refund.

### SEC-04 — Enforce atomic retail and platform-cost caps

**Observed:** Film Studio already provides versioned quote/hold settlement and retail caps in migration 0171; migrations 0167/0168/0172 add hold recovery. Free series planning is explicitly a platform cost without a retail hold in [series_plan_worker.py](../modules/series_plan_worker.py). These do not establish a universal atomic platform-cost cap.

**Required:** preserve existing customer credit holds/capture/release and add a distinct platform-cost reservation ledger or equivalent transactional control. Retail price is what the customer approves; internal provider cost and platform margin are administrator-only. Never return cost ledger fields through customer tools, reports or exports.

Admission must atomically reserve both the retail charge and conservative platform cost under organization/channel/platform period caps, counting committed spend plus outstanding reservations. Lock in a documented stable order; concurrent requests cannot pass independently and jointly exceed a cap. Daily/monthly windows, currency, rounding and administrator override rules are explicit. Recheck reservation validity at dispatch; expiry does not release an in-flight platform-cost exposure reservation blindly. A released customer hold is not evidence that the separate platform liability has ended.

Credit-exempt operator accounts, included/free planning, retries, research, embeddings, tools and nominally zero-credit work still consume platform CPU/provider budgets and quotas. No exemption bypasses platform caps. A $0 price is allowed only when a verified pricing record explicitly says zero for that exact operation; missing, expired, unpriced or unbounded cost means deny paid dispatch. A free local operation still needs CPU/time/token/queue limits. Unknown vendor cost requires a bounded conservative reservation or refusal, never an assumed zero. An external price change invalidates the relevant approved manifest as defined in SEC-05.

Meter actual usage when available, reconcile uncertain submissions and settle once. Release unused reservations only after the lifecycle proves they are no longer liabilities. Provider retry policy must distinguish known rejection from outcome unknown; a timeout is not permission to buy again. Capped spending does not silently lower quality or substitute models.

**Acceptance gate:** concurrent requests at balance/cap boundaries; free planning floods; exempt-account spend; explicit $0 versus missing prices; duplicate submits; provider timeout and accepted-but-unrecorded requests; period rollover; currency/rounding; cancellation and partial completion. Verify retail capture never exceeds its hold, platform liabilities stay counted, and customer APIs disclose no costs or margin.

### SEC-05 — Bind human approval to immutable, versioned execution plans

**Required:** use logical plan/approval records whose physical schema will be designed in a later authorized implementation. A canonical manifest includes schema version, trusted organization/channel, semantic policy version, exact model/provider identifiers and immutable revisions, parameters, prompts, input asset IDs plus immutable content digests, voice/character versions, tool/action sequence, output/privacy intent, pricing revision and approved retail total/ceiling. Also record a bounded internal execution-cost reservation without exposing internal prices in the customer view; bind that authorization to the approved plan through the broker.

Compute SHA-256 over a specified canonical serialization with deterministic object-key order, numeric and Unicode handling, and array order preserved where semantic. Exclude only explicitly listed nonsemantic display fields, such as localized labels and UI expansion state. User-visible generation-relevant text, prompts, model choice, policy and pricing are semantic. Store the canonical bytes/version and digest; do not recompute using mutable joins. Approval references the exact digest, authorized human identity, scope, permissions, timestamp, expiry and a one-use execution/replay key. Server checks current membership and approval validity again at execution.

Any change to policy, model/revision, input content, generation parameters, semantic prompt or customer price produces a new manifest and requires a new approval; invalidate the old capability and prohibit dispatch against it. Reject unsupported model versions rather than silently substituting. Bind quote expiry to approval expiry. An expired approval cannot be renewed by an agent. Preserve the recorded technical-retry policy in [Studio Planner](studio/PLANNER.md): a known-outcome technical failure may retry the same model/inputs only within the exact original approved retry allowance and atomically reserved platform-cost cap, with no additional customer charge. The retry consumes a fresh bounded dispatch permit and repeats all live checks. This differs from resuming polling the same provider task, which must not purchase again. An unknown outcome always reconciles first; no blind repeat purchase. A user re-roll, semantic change, different model, exhausted allowance or higher customer price requires a new quote and human approval.

Generation approval is distinct from public publishing or audience replies. Preserve the existing exact-cut publish approval and real-member restrictions. Publisher/Audience agents cannot mint approval rows or reuse a generation approval as permission to speak publicly. Default automatic replies remain disabled; enabling a future rule-based mode requires a separate scoped human policy and cannot weaken this baseline silently.

**Acceptance gate:** canonicalization fixtures; policy/model/input/price mutation; mutable asset replacement; expired quote; revoked membership; cross-org reuse; duplicate approvals and parallel execution; reused replay key; unavailable model; prompt-injection request to approve itself. Verify unchanged nonsemantic display fields do not change the digest, while every semantic mutation does. No generated plan, even a valid JSON document, authorizes itself.

## Planned implementation PR sequence

No commands, SQL or migrations are supplied or authorized by this specification.

**P0-BILL dependency register:** pending PR 787 (Paddle sandbox allowlist), PR 786 (failed-job cap), and PR 750 (concept-thumbnail hold pricing) must be reviewed against their current diffs, tests and merge status before implementation. They are not assumed merged or fixed by this document. Coordinate dependency order and settlement contracts rather than replacing or duplicating these changes. Their identifiers are review references supplied during this task; no claims about live activation are made here.

| PR | Dependency | Concrete reviewable result | Release gate |
|---|---|---|---|
| P0 docs | None | Architecture/security contracts and unresolved source/live evidence register | Owner review; no runtime claims |
| Security foundation A | Owner implementation authorization | SEC-01 caller inventory and migration to audited RPCs, MFA/break-glass rehearsal | Caller coverage and recovery verified |
| Security foundation B | Foundation A deployed and verified | Forward-only closure of legacy grants/writes and database AAL2 backstop | Direct bypass tests denied; operator recovery works |
| Broker boundary | Foundation B for privileged rollout | SEC-02 scoped roles, typed broker, container/network boundaries, redacted audit | Tenant and capability adversarial tests pass |
| Dispatch and budget | Broker boundary | SEC-03 fences/stops and SEC-04 atomic dual reservations | Race/reconcile/cap tests pass; no false refunds |
| Approval contract | Broker boundary; dispatch/budget before external use | SEC-05 immutable manifest, quote, human approval and replay enforcement | Mutation/replay/permission tests pass |
| Restricted Brain pilot | All above | Disabled-by-default supervised workflows through existing jobs and gates | Measured resource budget, owner-approved pilot; independent security review |

Use additive forward migrations only after authorization; do not renumber or edit applied migrations. Actual implementation sequencing must account for deployed callers and preserve a rollback path that does not reopen a vulnerable legacy API silently. Keep dangerous features disabled if dependencies are unavailable.

## Audit evidence and definition of readiness

Record safe structured events for policy decision, actor, trusted scope, run/plan digest, capability identifier digest, tool, fence revision, approval reference, reservation reference, provider task reference, state transition and reason code. Never log credentials, raw authorization headers, full private prompts or unrestricted comment content. Restrict audit access by role and tenant; set retention/deletion rules. Use append-only application permissions and separate integrity/backup controls; a database-owner trigger is not proof against a database administrator.

Readiness requires the full path from UI intent to broker authorization, dual budget reservation, queue, executor, provider outcome, storage/editor and explicit publish/reply gate. Independently review security changes and keep regression tests for every confirmed finding. Production deployment still needs human approval. A document, successful unit test, feature flag definition or container declaration alone does not prove live enforcement.
