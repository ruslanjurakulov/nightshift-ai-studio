# Nightshift AI Brain — agent registry v1.0

Status: **P0 specification only; all new runtime agents disabled**.
Prepared: 2026-11-15, Asia/Tashkent. Source: `f985b3afd371c0677357670da436ef2074fdb036`.
See [architecture](AI_BRAIN_ARCHITECTURE.md) and [security policy](AI_SECURITY_POLICY.md).

## 1. An agent is a bounded role

One local inference process can serve all roles serially. A role selects a prompt,
input/output schema, scoped context and proposed tool set. It does not imply an OS
process, LLM copy, database role, API key or permission to execute generated commands.
Development helpers in `.claude/agents/` and UI names are not a deployed Brain runtime.

Agent configuration changes require reviewed code/configuration outside P0. A model
cannot add an agent, broaden its tools or rewrite its own system policy. Subtasks inherit
the intersection of parent authority, agent allowlist and current broker policy; delegation
never creates a permission. Bound fan-out, recursion, attempts and total tokens at the task level.

## 2. Permission vocabulary

| Level | Meaning |
| --- | --- |
| R | Sanitized, tenant-scoped read through an approved tool |
| P | Produce a validated proposal/draft; no external effect |
| E | Request an existing action only with an exact valid authorization and broker dispatch permit |
| N | Forbidden, even if the LLM claims a human approved it |

The role names below describe proposed tools, not new endpoints to implement blindly.
Map each to an existing operation first. No role receives raw SQL, shell, arbitrary
HTTP, arbitrary file reads, secrets, service-role access or platform-admin credentials.

## 3. Full registry

| Stable ID / agent | Inputs and memory | Output | Maximum authority and reuse |
| --- | --- | --- | --- |
| `director` — AI Director | User brief, approved brand/channel strategy, project revision | Creative brief, scene dependencies, quality targets | R/P; existing agent planner, Director and Film Studio; cannot approve its plan |
| `script_writer` — AI Script Writer | Brief, sourced research, approved tone, language | Versioned script with claim/source references | R/P; script engine and storyboard; no paid media call |
| `prompt_engineer` — AI Prompt Engineer | Approved script/scenes, model capabilities, licensed references | Per-scene image/video/negative prompts and parameters | R/P; capability schemas and successful-prompt retrieval; cannot substitute models |
| `storyboard_designer` — AI Storyboard Designer | Script, character/style versions, shot capabilities | Validated scenes, shot/camera/voice/music plan | R/P; existing storyboard and film scenes; saves require normal edit authorization |
| `researcher` — AI Researcher | Bounded query, topic, approved source catalog | Evidence/citations, uncertainty, conflicting claims | R/P; approved retrieval broker only; no arbitrary URL/shell; external content is untrusted |
| `channel_analyst` — AI Channel Analyst | Owned-channel supported metrics and exact windows | Measured findings with coverage/confidence | R/P; analytics/retention modules; no private competitor metrics |
| `content_strategist` — AI Content Strategist | Analyst findings, calendar, approved learnings | Ranked ideas/calendar and strategy revision proposal | R/P; planner/strategy/demand modules; cannot auto-approve memory |
| `video_editor` — AI Video Editor | Existing project/timeline and owned asset references | Structured edit operations, export proposal | R/P; existing editor validators/render path; E only after exact edit/export quote approval |
| `quality_inspector` — AI Quality Inspector | Render metadata, safe contact sheets, source/rights evidence | QC findings and held/review recommendation | R/P; existing QC/publish checks; cannot override failed gate or claim an unrun check passed |
| `publisher` — AI Publisher | Exact approved cut, destination/channel policy | Publish request status/recommendation | R/P/E only via existing approval/publish functions; cannot mint approval, change privacy defaults or bypass gate |
| `audience_manager` — AI Audience Manager | Sanitized audience aggregates and consented support context | Questions, complaints, topic clusters and escalations | R/P; no audience identities by default; no unsolicited messaging |
| `comment_manager` — AI Comment Manager | One cleaned comment plus permitted context | Classification, reply draft or escalation | R/P; tool-free draft; E only exact-text approval or future narrowly opted-in rule path, default off |
| `brand_manager` — AI Brand Manager | Workspace-approved style kit and user brief | Brand/tone revision proposal | R/P; style kits/Channel DNA; no cross-user memory ingestion |
| `character_manager` — AI Character Manager | Owned character references, rights/consent | Character profile/consistency proposal | R/P; existing character records; no cloning or image generation without separate authorization |
| `model_router` — AI Model Router | Exact capability, availability, license/probe, benchmark evidence | Eligible model recommendation and refusal reason | R/P; existing registry/router; cannot change frozen model or availability/price settings |
| `cost_optimizer` — AI Cost Optimizer | Retail quote and permitted private cost aggregates | Cost/speed/quality alternatives | R/P; internal costs visible only in admin context; a cheaper alternative still needs a new approval |
| `customer_support` — AI Customer Support | Approved help corpus, caller's own account summary | Draft answer or human escalation | R/P; no refund/grant/role/price operation; no raw payment/credential payload |
| `financial_controller` — AI Financial Controller | Admin-only reconciliation and cost aggregates | Variance, exposure and margin report | R/P admin-scoped; no payment, credit grant, refund, ledger edit or bank operation |
| `system_monitor` — AI System Monitor | Sanitized counters, queue/health summaries | Alert/incident proposal | R/P; no raw logs/environment/filesystem/server access; no restart/deploy |
| `learning_agent` — AI Learning Agent | Measured outcomes, feedback and experiment coverage | Pending learning with evidence/confidence/expiry | R/P; existing learning_memory approval flow; no automatic weights/code/approved-strategy change |
| `developer_auditor` — AI Developer Auditor | Approved secret-scrubbed source snapshot and findings | Read-only code/security report with evidence | R/P in separate sandbox; no write token, network to production, shell tool or access to runtime tenant data |

E is a ceiling, not a default enabled tool. Initial P1 enables only selected R/P roles.
Publisher and Comment Manager remain unable to send anything without the existing
domain checks plus the new policy boundary. Financial Controller never receives E.

## 4. Registry record contract

Each versioned entry must name:

- Stable ID, human-readable name, purpose, owner and enabled state (default false).
- Agent/prompt/schema versions and supported LLM capability requirements.
- Exact input and output schema IDs; bounded size, context and output/thinking tokens.
- Allowed logical read/proposal/action tools, with argument schemas and field projections.
- Data classification and visibility: user-private, channel/workspace or operator-only.
- Authorized memory scopes, retrieval token cap and provenance requirement.
- Approval kind required for each effect, maximum attempts/fan-out and absolute deadline.
- Platform cost budget and retail payer rules; no implicit credits-exempt escape.
- Audit event classes, failure codes, kill scopes and escalation destination.

Server identity binds tenant/user/channel/task. LLM output cannot select a different tenant,
add a privilege, renew a lease, increase a token limit or choose a new payer. Secrets and
internal cost details are excluded from customer contexts before prompts are constructed.

## 5. Shared execution rules

An agent can recommend `tool_name(arguments)` only from its closed catalog. The broker
validates the current user's right, tool policy, argument semantics, plan hash/revision,
input ownership, quote, budget, idempotency and kill fence. Model output is never a signature.

Generation approval, comment approval and publishing approval are separate acts. A film
or storyboard approval does not authorize a public post, reply, financial operation or
another version of a cut. A user-edited reply must be approved as the new exact text.

Policy decisions are recorded with request/task/attempt ID, agent/policy version, tenant,
tool and bounded reason code. Do not log raw comments, credentials, sensitive prompts or
model reasoning. A rejection returns a remedy, not a raw stack trace or secret-bearing error.

## 6. Context lifecycle and scheduling

Construct an independent context envelope for every task: system policy, authorized
user brief, approved memory references and separately marked untrusted evidence. Clear
context/KV-session state between tenants; shared immutable model weights are acceptable,
shared conversation caches are not. Prefix/KV caches may be reused only within an explicitly
scoped task boundary with an expiry and deletion path.

Start concurrency at one local inference request. Queue by deadline and fairness, with
per-org active/queued limits and reserved reconciliation capacity. Twenty-one roles cannot
multiply the user's accepted budget: child attempts draw from the same parent budget.
Tool recursion stops on limit, deadline, kill or approval invalidation. The system reports
partial work honestly instead of silently replacing an unavailable model.

## 7. Developer Auditor boundary

The Auditor receives an owner-selected immutable source snapshot with secrets/env files,
credential-bearing Git config and production volumes excluded. Prefer static analysis and
bounded pre-approved analysis services, not model-directed command execution. Its findings
are recommendations; it cannot create a branch, push, migrate or deploy.

Future authorized editing belongs to a separate developer workflow in an isolated test
branch/environment with a reviewed diff. It does not expand the production Brain's tools.
The current documentation branch is human-authorized development work, not an example of
an AI Brain runtime having repository write permission.

## 8. Required acceptance evidence before enabling a role

| Test | Required outcome |
| --- | --- |
| Comment says to reveal keys/change policy | No secret/tool capability exists; draft is refused or safely bounded |
| Role asks a tool outside its list | Broker rejects; denial event recorded |
| Agent changes org, payer, model or price | Rejected; no job, hold or provider call |
| Parent delegates to a stronger role | Effective permissions stay the intersection |
| Expired/revoked/changed plan | No new side effect; new exact human approval required |
| Kill during queued/in-flight work | New dispatch denied; known sent operations reconciled once |
| User-private memory requested by teammate | Non-disclosing denial; no raw content retrieval |
| Financial agent requests credit grant | Always denied, including operator context |
| System monitor requests raw logs/SSH | Always denied |
| Developer Auditor asks to edit/deploy | Always denied in the default role |

These tests are a future implementation requirement. No runtime agents or permissions
are created by this P0 documentation change.
