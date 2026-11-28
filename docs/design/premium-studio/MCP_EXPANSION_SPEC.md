# Nightshift MCP expansion: audit, contracts and approval proposal

Status: **Phases A–C only; no implementation, schema or configuration change authorized by this document.** Audited 2026-11-16 (Asia/Tashkent) against main `f985b3afd371c0677357670da436ef2074fdb036` in the clean main checkout. All source references below are to that commit, not the P0 integration branch. Runtime configuration, production database contents and successful real ChatGPT/Claude connections were not inspected. No paid generation, publish, reply, provider request or secret read occurred.

This extends [docs/MCP.md](https://github.com/ruslanjurakulov/nightshift-ai-studio/blob/f985b3afd371c0677357670da436ef2074fdb036/docs/MCP.md), [docs/API.md](https://github.com/ruslanjurakulov/nightshift-ai-studio/blob/f985b3afd371c0677357670da436ef2074fdb036/docs/API.md) and `docs/FILM_STUDIO.md`; it does not replace their protocol, billing or Film contracts. The requested extension is Nightshift's own MCP product, not a new remote administration server, plugin installation or provider-key proxy.

## 1. Existing capabilities: retain these components

| Source evidence | Current behavior | Integration consequence |
|---|---|---|
| `command-center/app/api/mcp/route.ts:14–25,65–108` | Stateless Streamable HTTP, JSON responses, fresh server per request; bearer API key or OAuth hash; resource binding; 256,000-character body guard; GET/DELETE 405 | Reuse endpoint, transport, request IDs and auth dispatch. Do not add a parallel MCP service or unbounded stream. |
| `command-center/lib/api/mcp.ts:59–78` | Fourteen API-key tool names; four Studio tools intentionally excluded from OAuth | Studio support in REST/API-key mode is already implemented. Adding OAuth Studio is an authorization/budget project, not four renamed tool wrappers. |
| `command-center/lib/api/mcp-oauth.ts:22–65` | OAuth has three scopes and an explicit function mapping/allowlist; unmapped functions refused before network | No generic RPC escape hatch; any scope/endpoint expansion needs server and database changes together. |
| `command-center/lib/oauth/config.ts:18–25,76–109` | Resource `/api/mcp`; one-hour access tokens; discovery advertises actual scope set, PKCE and public-client flow | Existing grants do not acquire new scopes automatically. No token passthrough to suppliers. |
| `command-center/lib/api/mcp.ts:207–258` | Tool exceptions sanitized; uncertain effect remains uncertain; absent scope gets actionable error | Preserve error semantics and redaction. A thrown create must not be retried under a new key. |
| `command-center/lib/api/mcp-http.ts:1–31`; `supabase/migrations/0147_mcp_free_tier.sql:22–50` | Handshake/list/ping/notification checks counted; OAuth limit accounting avoids counting a call twice; all plans may connect, subject to credits, scopes and concurrency | New reads/resources also authenticate and count. Do not reintroduce a paid-plan gate merely to connect an app. |
| `command-center/lib/api/operations.ts:473–519` | Creative quote and create use existing database functions; exact model/params, maximum credits, required idempotency and body fingerprint | Keep the existing hold/capture/release ledger. A cost ceiling is necessary but is not cryptographic evidence that a human approved a new plan. |
| `supabase/migrations/0162_api_creative_models.sql:82–122,141–194` | Model listing uses API surface and entitlement gates; result files belong to jobs this key started; functions explicitly reject unallowlisted OAuth access | Never offer web-only models through MCP by treating a customer token as a browser session. Keep job attribution and asset authorization. |
| `command-center/lib/api/operations.ts:535–560` | Capability allowlist excludes web-only captions and unregistered music; media links follow authorized job files | No fabricated capability claims. Do not broaden a list without backend support and contract rights. |
| `command-center/lib/server/public-api.ts:11–20,43–65` | Anon-client RPC with hashed caller credential; media URLs signed server-side; OAuth adapter has no media signer/download path | New token-scoped file read needs explicit authorization and a narrow signer after that check; never return local paths or signing secrets. |
| `command-center/lib/mcp-oauth.ts:1–28`; `docs/MCP.md` connection sections | `MCP_OAUTH_LIVE=1` changes public presentation; source distinguishes ready, unverified and confirmed client connections | The flag is not a kill switch. Source implementation is not proof of production readiness or successful client integration. |

### Exact current tool inventory and money domains

| Existing tool | API-key mode | OAuth mode |
|---|---|---|
| `list_channels`, `list_videos`, `get_video`, `list_connected_accounts`, `get_job_status` | Existing read operations and key scopes | `videos:read` |
| `get_balance` | **API USD-cent balance**, not Studio credit balance | `videos:read`: **site credits**, grant cap/use and plan concurrency |
| `create_video` | Existing prepaid **API USD-cent** hold | `videos:create`: **site-credit** hold and connection monthly cap |
| `publish_video` | Existing API publish authorization/gates | `videos:publish`; OAuth schema deliberately omits idempotency key; repeated completed calls can post again |
| `request_download`, `get_download` | Existing paid download domain and key-owned order | Not offered |
| `list_models`, `quote_generation`, `create_generation`, `get_generation` | Existing `creative:quote/create/read`; creative generation spends **site credits**, including in key mode | Not offered |

Source: `mcp.ts:59–93,278–310,430–510`; `mcp-oauth.ts:25–65`; `operations.ts:473–560`. OAuth offers eight tools, not the entire fourteen-tool catalog. Client-facing ready-to-copy prompts in the website are not protocol-level MCP `prompts/list`: no `registerResource` or `registerPrompt` call exists in this builder. Do not claim existing MCP resources or server prompts.

Two important gaps:

1. API-key `get_balance` does not answer the available Studio site-credit balance. `api_creative_quote` explicitly removes `available` from its response (`0062_api_creative.sql:396–435`). A future credit-budget read must be intentional and scoped, not inferred from API dollars.
2. Existing `create_generation` guards price and idempotency but its tool schema has no human-issued approval reference. Do not describe it as implementing the new versioned project-approval contract already.

The seven models named by `0173_open_cleared_models.sql:15–31` are opened for **web sale**, with `api_exposure=web_only` preserved. Merely enabling OAuth Studio tools therefore does not make these seven generatable through MCP: `sellable_models(...,'api')` still excludes them. A valid API tool catalog may be empty or much smaller than Personal Studio's web catalog. Return the actual allowed set and a clear limitation, rather than weaken legal exposure gates to promise feature parity. An assistant can still propose project text for human review in the web UI without possessing model execution rights.

## 2. Product boundary

Personal Studio is the same experience and same tenant data for the owner and ordinary customers. OAuth consent does not turn a tenant administrator into a platform owner. Navigation mode selected in the top-right N avatar is presentation, never an authorization claim. Switching to Owner Command must not change the tenant attached to an existing MCP grant.

The first release should make an assistant useful at **reading a project, understanding its inputs and proposing edits**, without new spend or publication permissions. Project writing follows only after the shared durable model exists. Paid execution is last. Owner telemetry, if subsequently approved, is a separate restricted resource and remains read-only.

## 3. Canonical project contract: coordinate with Canvas–Timeline work

Reuse `films.id` as the durable project identity; `film_scenes.position` is playback order; `film_takes` and `media_assets` remain take history and asset identity. Keep `CanvasState`, existing node/wire validation and React Flow components. A proposed bounded Film-owned graph/binding extension is not another project database.

Source: `lib/studio/canvas.ts:56–89,379–395`; `lib/server/films.ts:20–23,127–148`; `app/api/films/[id]/route.ts:13–46`; `0166_films_core.sql:1207–1242,1321`.

Rules for MCP and browser callers must be identical:

- Typed dependencies represent creative inputs, **not playback order**. Neither topological sort nor node x-position silently reorders scenes.
- Stable `node_id -> scene_id / take_id / job_id / asset_id` bindings; never array-index identity. A prompt/dependency/model/reference edit increments the existing Film content version and invalidates affected stored quotes/approvals.
- Cosmetic node coordinates use a separately proposed layout revision; moving a card alone does not invalidate a paid content approval. Personal viewport is user-scoped. This layout field/revision does not exist as an approved contract yet.
- A timeline edit that changes a scene/take changes the Film record and returns the updated shared read model. It does not invent a generation-completed state. Backend-owned status, take results and billed amounts are never writable draft fields.
- MCP cannot read browser localStorage. Existing unsaved Canvas drafts need explicit browser import/review into an authorized project; the assistant must say `draft_not_synced`, not claim cross-device recovery exists.
- Concurrent browser/MCP edits use expected revisions and conflict responses. No last-write-wins overwrite; no JSON blob that silently replaces another user's draft.

## 4. Proposed scope and role matrix

All scope names in this section are **proposed**, except existing `videos:*` and API-key `creative:*`. A new OAuth scope needs consent UI, discovery metadata, SQL validation, endpoint allowlist, refresh/revocation behavior and tests in the same reviewed change. Refreshing an old token never broadens its grant. Do not issue synthetic API keys to sidestep OAuth controls.

| Capability | Proposed scope | Minimum tenant role | Extra constraints |
|---|---|---|---|
| Project/timeline metadata reads | `projects:read` | viewer | Film feature gate, grant tenant, same hidden/not-found behavior |
| Library metadata and expiring previews | `library:read` | viewer | Explicit grant; same-tenant asset authorization; no broad filesystem paths |
| Existing Studio catalog/quote over OAuth | `studio:read`, `studio:quote` | role equivalent to existing operation; Film quote requires editor | API surface only, legal/probe availability and entitlement checks retained |
| Project drafts/graph/scene edits | `projects:write` | editor | Expected content/layout revisions; structured allowed operations; no spend |
| New paid Studio/Film execution | `studio:create` | existing operation's role; Film start requires admin | Fresh human-bound approval, site credits, connection cap, platform cap, failure limits and kill switch |
| Cached analytics/research reads | `analytics:read` | existing channel permission | No external refresh or paid research; channel access checked again |
| Comment inbox reads | `comments:read` | existing channel permission | Minimized/redacted audience fields; untrusted text |
| Save a supplied reply draft | `comments:draft` | existing reply-draft role | Existing draft/review path only; no model call or sending; if AI drafting costs money it requires a separate priced operation |
| Platform aggregate telemetry | future `owner:telemetry:read` | **platform owner** | Separate audience/resource, recent MFA verified server-side and revocation checks; not an ordinary customer scope |

Film source roles are explicit: `0171_films_money.sql:16–17,111–113,1194,1290` (quote editor, start admin); `0166_films_core.sql:51–56,1207–1242` (read viewer, draft writes editor). Scope grant never raises the user's role.

## 5. Proposed tool catalog, in delivery order

Names below are contract proposals, not discoverable production tools. Reuse current names for current Studio functions instead of creating synonyms.

| Phase | Tool | Input summary | Output and prerequisite |
|---|---|---|---|
| M1 | `list_projects` | `cursor?`, `limit` 1–50, `archived=false` | Authorized Film summaries, content revision, actual status and feature availability; token-scoped Film read adapter required |
| M1 | `get_project` | `project_id` UUID | Versioned Film read model plus graph persistence state (`unavailable` until durable graph exists); no raw financial/worker fields |
| M1 | `get_project_timeline` | `project_id`, `expected_revision?` | Derived scene/take/asset order; durations null when unknown, completeness and content revision; no second timeline store |
| M1 | `list_project_assets` | `project_id`, bounded `cursor?`, `kind?` | Authorized asset metadata, provenance, preview availability and expiry; signer only after token/tenant/asset authorization |
| M1 | Existing `list_models`, `quote_generation`, `get_generation` | Existing strict schemas | Optional OAuth expansion only after corresponding token scope, attribution/budget and file-read contracts exist; retain current API-key behavior |
| M1 | `get_generation_budget` | no tenant override | Site-credit domain, held/available, connection/key cap and freshness; intentionally new narrow budget read, not USD conversion |
| M1b | `get_channel_analytics` | `channel_id`, bounded date window | Existing stored analytics with `observed_at`, coverage and unknowns; no quota-consuming refresh |
| M1b | `list_comments` | `channel_id`, cursor, bounded filters | Existing inbox snapshot, no unnecessary audience identity; comments marked untrusted |
| M1b | `get_research_notes` | `project_id`, cursor | Existing saved notes/citations only; `not_available` when no data model/source; no arbitrary URL fetch or new paid research |
| M2 | `validate_project_patch` | `project_id`, revisions, typed patch | Deterministic existing Canvas/Film validation; no save, no AI generation, no provider request |
| M2 | `apply_project_patch` | `project_id`, `expected_revision`, optional `expected_layout_revision`, typed operations, `idempotency_key` | Existing Film controller/save path plus approved graph extension; returns new revisions/read model or conflict; excludes take result/status/credit fields |
| M2 | `create_project_draft` | bounded title/brief and supplied scene proposals, `idempotency_key` | Existing `create_film_draft` semantics; editor authorization; supplied outline only, no hidden LLM call |
| M2 | `save_comment_draft` | `comment_id`, expected draft revision, supplied text, idem | Existing inbox draft path after token adapter; no automatic reply/send and no priced AI drafting disguised as free save |
| M3 | `quote_project` | `project_id`, `expected_revision`, selected node/scene IDs | Existing `quote_film` and exact approved card quote behavior; persisted expiring quote, lines, blockers, payer domain; no hold/generation |
| M3 | `start_project_generation` | `project_id`, `quote_id`, `approval_ref`, `idempotency_key` | Existing `start_film` or existing single-card create semantics through token adapter; current role, caps and hold/capture/refund; never auto-publish |
| M4, optional | `get_owner_operations_summary` | bounded window, allowed aggregate metrics | Restricted aggregate read contract only; unsupported/incomplete states; separate owner resource and authorization prerequisite |

Do not add bulk `run_graph` or `generate_all` shortcuts until a bounded immutable plan can price every required upstream operation. A multi-scene master prompt returns **proposals for review**. It cannot approve its own proposal, load provider secrets or start work from untrusted text.

No new publishing or comment-send tool is proposed. Existing `publish_video` keeps its present gates and private YouTube behavior; the new work must not increase autonomy. New project approvals and existing exact-cut publish approval are different actions and cannot authorize one another.

## 6. Concrete request/response contracts

Every new tool uses strict schema validation (`additionalProperties: false`), bounded arrays/strings and allowlisted enums; no arbitrary RPC name, SQL, shell, URL, role or `org_id` in a customer input. Tenant comes from the checked grant/key. A project ID is a selector, never authorization. Exact exported existing validators should be reused rather than copied.

Example proposal for a nonspending draft edit:

```json
{
  "project_id": "00000000-0000-4000-8000-000000000001",
  "expected_revision": 12,
  "idempotency_key": "caller-created-valid-existing-key-format",
  "operations": [
    {"op": "set_scene_prompt", "scene_id": "scene-stable-id", "text": "Supplied scene direction"}
  ]
}
```

Operation names and field types remain proposals until the Film contract review. `move_node` requires `expected_layout_revision`; `connect_input`, model/reference edits and scene order changes require the content revision. A patch spanning both must check both atomically. Reuse `canWire`, cycle/type validation and the existing Film scene limits; invalid input stops before save/spend. No operations named `set_job_status`, `set_charged`, `approve`, `change_owner`, `execute`, `set_secret` or arbitrary nested-object replacement.

Common proposed result:

```json
{
  "schema_version": 1,
  "request_id": "request-correlation-id",
  "state": "ok",
  "data": {"project_id": "...", "revision": 13, "layout_revision": 4},
  "provenance": {"source": "film_json", "observed_at": "server-time", "completeness": "complete"}
}
```

This is an extension of the existing API envelope, not a second conflicting REST transport. Preserve `isError` and request ID behavior; adopt a shared versioned output schema/structured content only after checking the pinned SDK and supported clients. Do not claim the illustrative IDs/times/revisions are runtime observations.

Error contract: `invalid_params`, `insufficient_scope`, `not_available`, `not_found`, `revision_conflict`, `layout_conflict`, `quote_expired`, `price_changed`, `approval_required`, `approval_invalidated`, `insufficient_credits`, `connection_limit_reached`, `run_limit_reached`, `failed_job_limit`, `kill_switch_active`, `rate_limit_exceeded`. Where existing APIs already use `film_changed`, `route_changed` or `key_credit_limit_reached`, preserve the public existing code and map it explicitly in a new tool version. Errors include safe remedy, request ID and bounded retry metadata; never secrets, raw exception messages or another tenant's current version. A repeated uncertain write reuses the same idempotency key.

## 7. Human approval, billing and execution boundaries

Proposed approval binding: checked caller/grant and tenant; project content revision; scene/node IDs; selected take and asset versions; exact model/provider revision; generation settings including duration/resolution/quality/audio/references; price/rate version; payer domain; total cap; expiry and nonce. Canonicalize/hash server-side. An assistant-supplied `approved: true`, prose, image screenshot or OAuth scope is not an approval.

Use the existing approval/quote gate as the extension point, not another financial ledger. `quote_film` already persists a 30-minute version-specific quote (`app/api/films/[id]/quote/route.ts:11–29`); `start_film` re-prices and atomically holds under current role checks (`start/route.ts:29–47`; `0171_films_money.sql:1256–1368`). A human approval reference for MCP must be issued by the authenticated review UI/server path, not by a model-accessible approve tool. Any missing binding is an implementation gap to resolve before M3.

OAuth Studio jobs need attribution to the existing connection so held plus captured spend counts atomically toward its monthly cap; API-key creative jobs already use key attribution. Extend existing reservation accounting and add a narrow attribution relationship if required; do not create a second credit balance. Refunded/released holds and retries must not double count. The proof that the attribution includes creatives is required before enabling create tools; existing video-only cap accounting is insufficient.

The public API dollar balance, site credits and supplier USD costs stay separate. No credit/USD guess. Supplier cost/profit is owner-only. Cheap supplier changes are not automatically permitted substitutions: changed provider/model/rate invalidates approval and requires a fresh quote. Missing price, unsupported input, inaccessible asset, absent rights acknowledgment or unavailable model fails before spend. Preserve `sellable_models(...,'api')` and `web_only` exclusions (`0125_model_shutdown.sql:170`).

## 8. Data safety and owner isolation

- Comments, uploads, web research, asset filenames and prompt text are untrusted data, never instructions. Return them as bounded records with provenance; don't concatenate into server system instructions or invoke follow-up tools described inside them.
- No arbitrary URL import in MCP. Reuse authorized upload/media ingestion with size/MIME checks; object IDs or verified upload tickets, not arbitrary filesystem paths. New research reads cannot become an SSRF proxy or paid search refresh.
- Customer read resources contain their own data and aggregate usage, not supplier balances, credentials, raw worker IDs/credit references or cross-tenant identity. `start/route.ts:14–26` already demonstrates the member-safe output allowlist; reuse this principle on MCP responses.
- Owner aggregate reads require actual platform authorization and server-verified recent MFA; do not trust editable user metadata, model claims, avatar mode or stale token role labels. Never reuse an owner session service client to execute a customer call. `lib/server/owner-reads.ts:16–55` is a source contract to reuse, not a broadly callable MCP RPC.
- Prefer deferring owner MCP rather than extending customer scope strings to private infrastructure. If approved later, use a distinct protected resource/audience with the same tested transport/auth components; never accept a customer `/api/mcp` token at the owner resource. Exact resource path is an approval decision, not deployed configuration.
- No owner write tools: no grants/reversals, pricing changes, provider top-ups, credential reads, SQL, migrations, SSH, Docker socket, deploy, git pushes, shell, code edits or kill-switch disablement. Owner control buttons remain existing authenticated MFA paths, not AI-controlled operations.
- A central admission policy must gate new paid/write work and enforce connection/workspace/platform budgets and emergency stop. Existing `MCP_OAUTH_LIVE` is only presentation and must not be sold as that protection. Read-only availability during an incident follows the separate approved kill-switch policy.

## 9. Resources, prompts and protocol compatibility

Optional resource templates after the same authorization adapters exist: `nightshift://projects/{id}/summary`, `/timeline`, and `/assets`; no unscoped customer directory, credential resource or raw logs. Resource read rechecks grant and membership every time. Default metadata-only, bounded pagination and freshness; no signed media URL cached as permanent. Resource endpoints/notifications count against the same authenticated request policy.

Optional protocol prompts: `plan_project`, `review_project`, `explain_quote`, `summarize_channel`, `draft_reply`. They are user-selected templates that reference allowed tools; they do not secretly run an LLM, spend tokens with a supplier, authorize execution or change system policy. Tool descriptions contain trusted static guidance; untrusted project/comment text is separate structured input. Host/client confirmation UI is useful but is not the server approval record.

Official authorization and tools pages at `https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization` and `/server/tools` were read for this plan. They support least-privilege resource authorization, credential-dependent discovery and human control. The repository pins SDK1.32.0 and wraps a specific handler-installation behavior (`mcp.ts:245–248`). Protocol/SDK upgrades are separate compatibility work: validate required metadata, schemas and output format against the negotiated protocol and real clients. Do not turn on new optional capabilities or change the stateless transport merely because a newer document describes them.

## 10. Implementation proposal and source-file change map

All rows require separately approved Phase D scope. Additive migration filenames are deliberately not allocated in this plan; current pending P0 migration numbering must be reconciled first.

| Slice | Existing files to extend | Required backend work and release gate |
|---|---|---|
| M0 baseline | `docs/MCP.md`, `command-center/tests/api-mcp.test.ts`, `command-center/tests/mcp-studio-tools.test.ts`, OAuth suites | Capture actual scopes/tool inventory and protocol negotiation with mocked provider execution; no live claims |
| M1 reads | `lib/api/mcp.ts`, `lib/api/operations.ts`, `lib/api/mcp-oauth.ts`, `lib/oauth/config.ts`, `lib/server/public-api.ts`, consent UI/i18n | New bounded token-auth read operations and SQL allowlists/consent; deny by default; existing Film/library/read serializers reused |
| M1b analytics/inbox | Existing channel analytics and `lib/server/comment-inbox.ts` data contracts | Explicit channel-scoped snapshot serializers and OAuth readers; no token-to-session impersonation; quotas/PII contracts |
| M2 draft writes | Above, `lib/films.ts`, shared Film controller, `lib/studio/canvas.ts` validators, Film save RPC | Approved durable graph extension and content/layout version split first; token-scoped editor adapters; optimistic concurrency/idempotency |
| M3 paid execution | Existing creative operations, Film quote/start path, OAuth grant budget attribution | P0 billing/failure mitigations verified in integrated head; no lost thumbnail/b-roll cost; existing holds and member-safe outputs; server-issued human approval and emergency stop |
| M4 optional owner | `lib/server/owner-reads.ts`, bounded telemetry serializers, auth/discovery components | Explicit owner-only resource/audience and fresh MFA contract; privacy/completeness review; read-only scope |

Browser routes currently use signed-in anon+cookie clients and RLS (`lib/server/films.ts:20–23,73–80`). They cannot be mechanically reused by supplying an arbitrary `user_id`, calling them from a service-role client or adding every function to `oauthRpc`. Extract/reuse shared operation serializers and implement narrow database authorization for the token principal. Film flag (`NIGHTSHIFT_FILM_STUDIO`), platform enabled switch, channel gates and current roles remain effective.

Dependency order is split by capability. M1 reads require narrow token-authorized
read adapters, scope consent and safe serializers; they may read existing Film
projects before durable graph storage exists, provided graph state explicitly
returns unavailable. M2 graph mutations require the approved durable Film/Canvas
contract and revision rules. M3 paid plans require those content contracts plus
P0 quote/hold/failure reconciliation, approval and emergency-cost admission.
UI redesign is not a reason to expose paid tools earlier. Pending PR status and
exact head dependencies belong to the coordinator's security dependency report;
no pending branch is assumed merged/deployed here.

## 11. Required acceptance evidence

1. Discovery snapshots: exact legacy fourteen/eight sets unchanged for old keys/grants; newly scoped tools appear only after explicit consent; every ungranted direct `tools/call` fails without database effect.
2. Security: revoked/expired/wrong-audience tokens, removed members, cross-tenant project/asset/comment IDs, forged owner metadata, missing/recently expired MFA, unknown fields, nested oversized patch, SSRF paths and prompt-injected comment instructions all fail appropriately; errors reveal no credentials or private objects.
3. Concurrency: browser and MCP edit same Film version; one save wins, stale caller gets conflict and retains local proposal. Cosmetic movement doesn't change paid content approval; changed dependency or selected take does. Timeline scene move never reorders dependency edges.
4. Billing: free connect remains free; quote/reads invoke no provider; API USD versus site credits stays correct; welcome/pack/subscription constraints retained; every create includes connection held+captured cap, idempotency and plan concurrency. Two parallel starts cannot exceed a remaining cap. Replayed/uncertain creates do not duplicate holds.
5. Approvals: forged/expired/replayed/cross-grant refs, changed price/provider/model/asset/content version and missing rights acknowledgments are refused before provider execution. AI cannot create a valid human approval. Existing publish exact-cut approval cannot authorize generation and vice versa.
6. Failure safety: provider refusal/timeout/unknown charge, released customer hold and repeated retries do not bypass the platform cost/failed-job limits or emergency stop. No test calls a paid provider; use mocks and isolated security lab only.
7. Media: authenticated correct asset metadata, expiring original links, missing local volume, deleted asset, other key's job and other tenant's storage all return honest states; metadata does not manufacture an available file.
8. Client/protocol: handshake, discovery, token refresh, re-consent, tool list and safe structured errors tested against pinned SDK and negotiated version; real ChatGPT/Claude product connection remains `unverified` until an authorized actual connection succeeds. Do not mark mock callback E2E as production confirmation.
9. UX: same project state in Personal Studio and MCP; human review links focus the existing screen/card rather than duplicate editor. Role-specific owner reads never appear in customer tools, menus or cached outputs. Public explanations localized en/ru/uz and never show supplier cost/profit.

Existing tests to extend: `command-center/tests/api-mcp.test.ts`, `mcp-oauth-tools.test.ts`, `mcp-studio-tools.test.ts`, `mcp-assistant-session.test.ts`, `oauth-endpoints.test.ts`, `oauth-discovery.test.ts`; Python `tests/security/test_sec_mcp_oauth.py`, `test_sec_mcp_free_tier.py`, `test_sec_mcp_studio_tools.py`, `test_sec_breach_mcp_studio_0162.py`; Film and Canvas suites after the data-contract change. Tests listed here are proposed acceptance work, not claimed to have run in this read-only audit.

## Approval boundary

Ready for owner review: the incremental scope, reuse map and safety contracts above. Not approved: any new OAuth scope, schema, application/tool implementation, supplier integration, production flag, grant limit, paid benchmark, publication or deployment. The uploaded master brief explicitly separates Phases A–C from Phase D; all implementation must first receive that scope approval.
