# Nightshift Agent → Node Builder, Phase 1

## Purpose
Build Nightshift-owned, auditable creative workflows: Brand Kit → Catalog → prompts → original image/video/vector model adapter → human review → export. Krea Nodes is a **benchmark**, not a provider integration.

## Implemented in this PR
- Zod v4 strict, versioned `AgentWorkflow` data contract, bounded to 64 nodes / 128 edges.
- Allowlisted registry of declarative node types. No arbitrary shell/script execution.
- Unique node IDs, edge validation, duplicate-edge checks, topological ordering and cycle detection.
- Fail-closed review gate for `asset.export`: every incoming path must traverse `review.approval`.
- Reject inline `apiKey`, `providerKey` and `endpoint` in creative nodes.
- Deterministic example ad campaign workflow.
- Unit tests for valid graphs, cycles, unknown types, review bypass, duplicate and missing links, inline secrets.

**This is NOT a workflow executor, AI agent, model API adapter or visual editor.** It makes zero network/provider calls, debits no credits, writes no tenant data and cannot publish/deploy.

## Next milestones
1. Typed node input/output contracts and authenticated, tenant-owned workflow storage with RLS.
2. Visual canvas editing, undo/versioning, workflow compilation preview, accessible keyboard operations.
3. Server-side validation of every node config; encrypted managed credential references, never client-supplied secrets.
4. Agent converts natural-language intent to schema-limited draft graphs with bounded cost estimates; user approves plan.
5. Asynchronous workers, per-node idempotency, timeouts, credits reserve/settle, immutable billing and failure recovery.
6. Direct-provider adapters: Ideogram Vector official API; BytePlus ModelArk Seedance (model/version/region/retirement/contract), license and redistribution review first.
7. Test with actual Supabase RLS, tenant isolation, safe credentials and publish gate OFF. No public posting without approval.

## Security note
Review node in a graph is only a structural rule. Runtime must validate **real authenticated human approval** and authorized asset ownership; the mere presence of a review node never counts as actual user approval. Model provider terms and pricing must be verified immediately before enabling paid usage.


## Phase 1B — visual preview implemented in draft PR
The noindex route `/agent-builder` renders a responsive graph planning interface. Users can rename the plan, add/remove allowlisted nodes, rename nodes, connect compatible node types, disconnect edges, reset the example, see structural diagnostics, and download a validated JSON draft. This uses only client-side state and an in-browser Blob export; nothing is saved to Supabase, no AI Agent actually runs, and no credits are used.

`agent-graph-editor.ts` implements a narrow typed connection matrix, immutable graph edit helpers and validation before adding an edge. `agent-graph-editor.test.ts` tests distinct identities, removal, incompatible/duplicate connections and unknown nodes.

### Limitations to resolve in phase 2
The first canvas is an accessible node-card/connection-list composition, not yet a draggable spatial node-edge canvas. Port types, role-based workspace persistence, actual approval tokens, model execution and the authenticated application navigation still require implementation. The public noindex preview intentionally has no secrets, provider calls, or saved private user data.

## Phase 1C — movable canvas and typed ports
Added a client-side draggable, bounded node-card workspace with accessible directional controls. A port map defines output/input compatibility for each allowlisted node type. New connections require both compatible types and the existing fail-closed graph validator. The canvas remains a draft-only planning surface: it has no worker executor, credentials, API calls, billing, persistence, approval token, SVG edge path rendering, collaboration, or deployment. Position changes currently exist only in client state, not in downloaded graph JSON. Native HTML drag works on supported pointer devices; arrow controls cover touch/keyboard repositioning. Dragging card positions is not equivalent to an authenticated automation execution.

## Phase 1D — SVG wiring and portable JSON drafts
- The editor draws noninteractive SVG cubic connection paths behind draggable nodes, using fixed world coordinates with scrolling.
- Export uses a versioned `nightshift.agent-draft` envelope containing the fully validated workflow and bounded per-node positions. Import accepts only this format, rejects files above 150 KB, unknown fields, off-canvas positions, unsupported versions, unrecognized node IDs and invalid approval gates.
- Import/export operates only in the browser. No data is uploaded to Supabase or backend. Import **never** automatically executes an AI model.
- Connection creation and removal remain accessible via selects and the connection list; port-to-port drag wiring, undo/redo and persisted/authenticated version history are still future milestones.
- GitHub CI must be reviewed before merging. A review node in saved JSON is never equivalent to a user's live approval.

## Phase 2A — private draft persistence (implementation in this draft PR)
- New migration `0129_agent_workflow_drafts.sql`: distinct from existing billing-backed `workflows` in migration 0073.
- Tables `agent_workflow_drafts` and `agent_workflow_draft_versions` with owner-bound foreign keys, RLS enforced for read, immutable version snapshots, and no direct authenticated write grants.
- Atomic `save_agent_workflow_draft(draft_id, expected_version, document)` uses current `auth.uid()`, row locks, version compare-and-swap, a 50-draft limit per person and 30 saved revisions per draft.
- `GET/POST /api/agent-builder/drafts` and `GET /api/agent-builder/drafts/[id]?version=N`; all use the cookie-bound logged-in user's anon Supabase client. POST uses same-origin CSRF checks and a hard streaming body limit.
- The editor has optional cloud Save, List and Load buttons. Imported local JSON starts a new cloud document instead of overwriting an older one.
- Feature flag `NIGHTSHIFT_AGENT_DRAFTS_ENABLED=true` is REQUIRED to expose the endpoints; it defaults OFF. Do not enable on production before disposable SQL and route tests pass.
- `tests/sql/agent_workflow_drafts_rls.sql` is a **disposable database test only**: two synthetic auth users, cross-user SELECT and save refusal, append-only versions and stale-version conflict. Rollback at end. This test has not been executed in this PR.

### Required deployment/release sequence (NOT performed)
1. Inspect migration numbering and apply only to a disposable Supabase instance; ensure 0129 is not reserved on another branch.
2. Run isolated RLS SQL tests and enforce that an authenticated API client cannot bypass the application-level graph validator via direct RPC calls.
3. Run command-center typecheck, unit tests, lint, route CSRF and cross-tenant tests; add version concurrency/race tests.
4. Deploy authenticated UI in a safe staging environment and explicitly toggle feature flag THERE, not in production.
5. After security review, obtain explicit production release approval. No automated migrations or production feature enablement.

### Remaining security caveat
The database RPC now also checks allowed node types, non-empty labels, empty node configs (no provider credentials), typed edge kinds, duplicate edges and bounded positions. The TypeScript parser remains authoritative for full structural validation and future typed configuration. A caller with a valid authenticated session can still invoke RPC directly; keep the execution engine disconnected. Before enabling this feature in production, finish equivalence tests for the SQL and TypeScript validators, run real cross-tenant tests and review migration safety. **This PR remains NO-GO for production until these checks pass.**

## Phase 2B — deterministic Agent Planner preview
- `agent-planner.ts` safely maps recognized image/video/vector creative intent into approved, editable, schema-validated node graphs. Explicit output choice is required when the request is ambiguous.
- `/agent-builder` has a local planner input with three output types. The text request is not sent to a provider; it is used only to select a deterministic template and then discarded from the graph.
- The planner makes no price claims, picks no paid model, never issues API calls and never treats a structural review node as authorization.
- `agent-planner.test.ts` contains unit scenarios for media-specific graphs, review presence, ambiguous requests, unsupported intents and length bounds.

## CI blocker remediation
- Security lab run 41168917077 reported a syntax error in migration 0129; a mistakenly duplicated SQL suffix was removed and the validation block repaired.
- Frontend run 41168917085 reported a launch-checklist failure because `/agent-builder` is an authenticated/private route not listed in the public sitemap. The existing private-route test skip list now classifies it explicitly as private.
- These are code changes pending repeat CI. Do not treat authored unit tests as executed test results.

## Phase 2C — provider selection and quote planning
- Added `agent-providers.ts` allowlisted direct-developer source catalog: Ideogram vector and BytePlus video. It is not an operational model registry; model versions and commercial licensing are unverified.
- `planProviderSelection` refuses mismatched capabilities and returns `canExecute: false`, `estimate: null`, explicit blockers and a mandatory review marker.
- `validateProviderCostQuote` accepts only structured provider-origin prices with a model ID and bounded amounts/valid timestamps; it does not call a provider or authorize billing.
- The Agent Builder displays the candidate source and unquoted cost explicitly. No third-party API calls are made, and no Krea/Higgsfield reseller integration is present.
- Any real provider adapter will require contractual redistribution rights, authenticated server-only credentials, per-user credit reserve/settle, idempotency, model version retirement safeguards, provider error mapping, and E2E tests. These are not implemented yet.

### CI blockers found in prior run
Frontend check passed. Security lab found PostgreSQL `42725 operator is not unique: unknown - unknown` in the new SQL function; explicit JSONB subtraction operands/casts were added. Python tests also found two unrelated unpinned Phase 2B.1F harness workflows and the 0129 migration review pin; workflow action pins, credential persistence, and the explicit reviewed 0129 migration list were updated. All changes require fresh CI evidence; do not claim green until checks finish.

## Phase 2D — CI catalog and workflow supply-chain repairs
After the previous PR run, Frontend passed, but the Security lab catalog test failed because migration 0129's person-owned tables and RPC were not declared. We now declare a `Person(owner_id)` isolation kind separately from organization-owned data; tests assert owner-only reads and no direct inserts. `save_agent_workflow_draft` is registered as an authenticated-only function in the closed function catalog.

The Python suite found the disabled-by-default `NIGHTSHIFT_AGENT_DRAFTS_ENABLED` flag absent from `deploy/.env.web.example`; it is now listed explicitly as `false`. It also flagged unpinned GitHub Actions in the read-only monitor and two disposable local Supabase workflows. Those actions are now locked to reviewed 40-character commit hashes, and checkout credentials remain nonpersistent. For `supabase/setup-cli`, v1.7.1's upstream immutable commit is `ab058987d8d6c725971f6cf9d0b5c98467e30bd1`.

These are PR-only changes. Fresh CI is required. No production Supabase migration, cloud flag enablement, merge or real model execution occurred.

## Phase 3A — server-side original provider adapter boundary
- `command-center/lib/server/agent-provider-adapters.ts` creates a server-only preparation boundary for Ideogram vector and BytePlus video requests. Provider model IDs must be present in a separately approved allowlist; arbitrary client endpoint URLs and API keys are rejected.
- Every request has a UUID request ID and owner ID, bounded prompt and asset list. This is **schema checking, not a substitute for actual authenticated user and asset ownership checks**.
- License/redistribution verification is a blocking condition. `inspectAdapterRequest` returns an inert plan; `executeAdapterRequest` always throws `nightshift_agent_provider_execution_disabled`.
- `agent-provider-adapters.test.ts` checks rejection of unapproved models, leaked extra fields, unsupported capability, missing terms approval and any execution attempt.
- No API endpoints, credentials, worker jobs, credit reservations or paid model calls were added. This cannot be toggled on with a flag. Actual direct API integration requires a separate reviewed implementation and explicit release approval.

CI status from the preceding commit is not assumed to carry over to these changes. Keep this PR draft until fresh frontend, Python and disposable security lab tests pass.

## Phase 3B — latest CI repairs
The preceding run of PR #652 found three remaining categories:
- Frontend TypeScript: the inert provider adapter unit test passed a readonly `assetIds` array where `AdapterRequest` expects an ordinary mutable array. The test fixture now uses a correctly typed array; the implementation still does not execute.
- Disposable Security lab: generic stranger/anon insert tests tried to clone a non-existent seeded personal workflow row. Personal tables are now attacked with a blind direct INSERT instead; authenticated-user owner isolation remains independently tested by `test_sec_agent_workflow_drafts.py`. This avoids weakening RLS.
- Python deployment mapping: new `NIGHTSHIFT_AGENT_DRAFTS_ENABLED` key was declared in the deploy template but missing in `deploy_web.yml`'s strict environment allowlist. It is now mapped from GitHub vars; absent or anything other than the literal string `true` leaves the endpoint disabled.

All three remediations are committed but require CI rerun. Production migration, feature enablement, API billing and publishing remain OFF.

## CI check — media memory regression isolation
On commit `51fe8ffa04083178980a758819cd131c40f837c6`, Frontend and Security lab passed. The Python suite executed 10,443 tests, reporting one error in a real FFmpeg regression test (`test_a_big_coded_frame_behind_a_crop_window_is_refused_at_ingest`): clean clip process RSS exceeded the intentionally reduced 256 MiB attack fixture limit (271 MiB observed on the runner). In `tests/test_breach_media_memory.py`, the malicious coded-frame refusal continues to be tested under the tight 256 MiB limit, while the clean clip is tested under the actual unchanged production memory limit. This is a test isolation fix, not a higher runtime memory allowance. Re-run the entire CI; do not mark this PR ready based solely on the previous two green jobs.
