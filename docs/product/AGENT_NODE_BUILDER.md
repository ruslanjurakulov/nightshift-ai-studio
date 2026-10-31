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
