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
- Migration `0130_agent_workflow_drafts.sql` (written as 0129, renumbered to 0130 on 2026-11-11 because 0129 went to the editor export frames, #661): distinct from the billing-backed `workflows` of migration 0073. Applied as one transaction with `lock_timeout = '5s'` (its foreign key to `auth.users` locks that table against sign-ups while it runs); its last block asserts the end state (grants, RLS, the one owner-only read policy per table, SECURITY DEFINER with an empty `search_path`). Undo: `docs/sql/rollback_0130_agent_workflow_drafts.sql`, which refuses while any plan exists unless its override line is set on purpose.
- Tables `agent_workflow_drafts` and `agent_workflow_draft_versions`: one person's rows (not the organization's, not the operator's). RLS is enabled (not forced: the two functions are SECURITY DEFINER owned by the migration role, the repository's pattern); signed-in users may SELECT their own rows; no API role (anon, authenticated or service_role) may write either table.
- `save_agent_workflow_draft(draft_id, expected_version, document)` binds to `auth.uid()`, takes a row lock and compares the version, allows 50 plans per person (under a per-person advisory lock) and keeps the newest 30 versions of each plan (a save past 30 prunes the oldest; version numbers keep counting). `delete_agent_workflow_draft(draft_id)` lets the owner remove a plan and all of its versions. Another person's id reads exactly like a made-up one (`draft_not_found`) for both.
- The function checks the whole document and fails closed: exactly the known keys at every level (a missing key is a refusal, not a NULL that slips through), JSON types, format/version values, 64 nodes / 128 edges, the node id pattern and uniqueness, the eight registry types, labels (1-80 characters) and the name (1-120), both measured raw and refused if they hold no visible character or any control, direction, zero-width or tag character (the BR-L-120 class), `config` exactly `{}`, the typed edge kinds, duplicate edges, an export with no incoming (reviewed) edge, and positions as plain integers inside the canvas. `lib/agent-graph.ts` and `lib/agent-draft.ts` apply the same rules, so a draft the editor accepts is one the database accepts.
- `GET/POST /api/agent-builder/drafts`, `GET /api/agent-builder/drafts/[id]?version=N` and `DELETE /api/agent-builder/drafts/[id]`, all with the signed-in user's cookie-bound Supabase client. POST and DELETE are same-origin checked; POST has a hard streaming body limit. A refusal of the function (a bad document, a conflict, a limit, another person's id) is a 4xx; only a missing function or an unreachable database is a 503.
- The editor has optional cloud Save, List, Load and Delete buttons. Imported local JSON starts a new cloud document instead of overwriting an older one.
- Switch `NIGHTSHIFT_AGENT_DRAFTS_ENABLED` (on, 1, true or yes; default off): off, every draft route answers the public 404 before reading the session.

### What the switch does NOT cover
The switch hides the web routes only. Once migration 0130 is applied, **any signed-in user can call `save_agent_workflow_draft()` and `delete_agent_workflow_draft()` directly through PostgREST with the browser (anon) key, whatever the switch says**, and read their own rows of the two tables. That is accepted on purpose and bounded by the database itself: 50 plans per person, 30 versions per plan, 150 KB per version, the document rules above, and only the caller's own rows. Nothing stored is ever executed, billed or published. If even that exposure is unwanted before launch, do not apply 0130 yet (or apply its rollback).

### Tests
`tests/security/test_sec_agent_workflow_drafts.py` (security lab, real Postgres): every guard of the function has a test that fails when the guard is removed, including two-connection races for the 50-plan limit and the version lock, and the rollback. `tests/security/test_sec_isolation.py` attacks real seeded rows of both tables (`tests/security/sec_agent_drafts_0130.py`). `command-center/tests/agent-drafts-route.test.ts` covers the switch, same-origin, the body cap and the error mapping.

### Required deployment/release sequence (NOT performed)
1. Confirm 0130 is still the next free migration number; apply it to a disposable Supabase instance first.
2. Run the security lab and the Command Center checks (typecheck, unit tests, lint).
3. Apply 0130 to production only with explicit approval, then turn the switch on in staging before production.

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

The Python suite found the disabled-by-default `NIGHTSHIFT_AGENT_DRAFTS_ENABLED` flag absent from `deploy/.env.web.example`; it is now listed (empty = off). It also flagged unpinned GitHub Actions in the read-only monitor and two disposable local Supabase workflows. Those actions are now locked to reviewed 40-character commit hashes, and checkout credentials remain nonpersistent. For `supabase/setup-cli`, v1.7.1's upstream immutable commit is `ab058987d8d6c725971f6cf9d0b5c98467e30bd1`.

These are PR-only changes. Fresh CI is required. No production Supabase migration, cloud flag enablement, merge or real model execution occurred.

## Phase 3A — server-side original provider adapter boundary
- `command-center/lib/server/agent-provider-adapters.ts` creates a server-only preparation boundary for Ideogram vector and BytePlus video requests. Provider model IDs must be present in a separately approved allowlist; arbitrary client endpoint URLs and API keys are rejected.
- Every request has a UUID request ID and owner ID, bounded prompt and asset list. This is **schema checking, not a substitute for actual authenticated user and asset ownership checks**.
- License/redistribution verification is a blocking condition. `inspectAdapterRequest` returns an inert plan; `executeAdapterRequest` always throws `nightshift_agent_provider_execution_disabled`.
- `lib/server/agent-provider-adapters.test.ts` (next to its module; `vitest.config.ts` now collects `lib/**/*.test.ts`, which no run picked up before) checks rejection of unapproved models, leaked extra fields, unsupported capability, missing terms approval and any execution attempt.
- No API endpoints, credentials, worker jobs, credit reservations or paid model calls were added. This cannot be toggled on with a flag. Actual direct API integration requires a separate reviewed implementation and explicit release approval.

CI status from the preceding commit is not assumed to carry over to these changes. Keep this PR draft until fresh frontend, Python and disposable security lab tests pass.

## Phase 3B — latest CI repairs
The preceding run of PR #652 found three remaining categories:
- Frontend TypeScript: the inert provider adapter unit test passed a readonly `assetIds` array where `AdapterRequest` expects an ordinary mutable array. The test fixture now uses a correctly typed array; the implementation still does not execute.
- Disposable Security lab: generic stranger/anon insert tests tried to clone a non-existent seeded personal workflow row. The lab now seeds one plan for each of two people, and the isolation tests attack those real rows with whole, valid inserts (superseding a blind `insert ... default values`, which a permissive policy would not have been caught by).
- Python deployment mapping: new `NIGHTSHIFT_AGENT_DRAFTS_ENABLED` key was declared in the deploy template but missing in `deploy_web.yml`'s strict environment allowlist. It is now mapped from GitHub vars; absent, empty or anything but on / 1 / true / yes leaves the routes a 404.

All three remediations are committed but require CI rerun. Production migration, feature enablement, API billing and publishing remain OFF.

## CI check — media memory regression isolation (reverted)
An earlier commit moved the clean 64x64 clip check in `tests/test_breach_media_memory.py` outside the strict 256 MiB limit. That made the test unable to catch a limit that refuses every file, so the hunk is back to `main`'s version exactly. A runner whose ffmpeg baseline exceeds the fixture limit needs its own fix on `main`, not in this PR.
