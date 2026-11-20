# Premium UI and shared Studio: approval package

Status: **Phases A–C complete for review; Phase D implementation is not authorized.**
Audit date: 2026-11-15 UTC / 2026-11-16 Asia/Tashkent. Frozen source: main
`f985b3afd371c0677357670da436ef2074fdb036`, reconfirmed against remote main.

This package applies the owner's uploaded `CODEX_MASTER_PROMPT.md` and the ten
numbered premium mockups. It is a source-grounded extension plan, not a working
redesign, migration, implementation result or evidence that production has the
capabilities pictured. Application files, original brand assets, database,
secrets, server and deployment configuration are unchanged. No paid generation,
payment, public publishing, automated reply, merge or deployment was performed.

## Read the package

| Document | Decision and evidence |
|---|---|
| [Reference manifest](REFERENCE_MANIFEST.md) | Original archive identity, all ten screens, brand references and visual precedence. |
| [Canvas/Timeline audit](AUDIT_CANVAS_TIMELINE.md) | Existing implementation, local versus durable state, actual handlers, remaining gaps and pending PR793. |
| [Customer screen/control map](CUSTOMER_SCREEN_MAP.md) | Routes, visible controls, APIs, persistence, authorization and feature parity across the customer experience. |
| [Owner data contracts](OWNER_DATA_CONTRACTS.md) | Seven owner screens, provider/payment/cost provenance, coverage and unavailable states. |
| [Visual design contract](VISUAL_DESIGN_CONTRACT.md) | Exact brand reuse, layered navy/violet and accessible light theme, Lucide mapping and six-width QA. |
| [Canvas–Timeline contract](CANVAS_TIMELINE_CONTRACT.md) | One Film project identity, existing graph model, meaningful synchronization, revision and recovery boundaries. |
| [MCP expansion specification](MCP_EXPANSION_SPEC.md) | Dedicated MCP audit: existing 14 API-key/8 OAuth tools, least-privilege incremental expansion and execution gates. |
| [Security/dependencies](SECURITY_DEPENDENCIES.md) | Owner versus admin, tenant/MFA/privacy boundaries, exact pending PR heads and migration allocation conflicts. |
| [Implementation proposal](IMPLEMENTATION_PLAN.md) | Small reviewable slices, file changes, dependency graph, acceptance evidence and explicit approval scope. |

Source citations refer to the frozen main commit. Proposed endpoints, scopes,
metadata fields and tests are labelled proposals. A historical CI result in an
open PR is not a test run of this package or proof of deployment.

## Parallel planning and independent review

Six development agents divided the work: Canvas/Timeline architecture, customer
controls, owner data/provenance, security/dependencies, visual/accessibility and
a dedicated MCP specialist. The coordinator reconciled their contracts into
this single package. These are development review assignments, not newly
deployed Nightshift runtime agents or separately loaded LLM instances.

Independent architecture review identified and corrected two medium design
findings: duplicate node/binding authority, and conflicting MCP read-versus-graph
prerequisites. The corrected contract derives display mirrors from one canonical
binding; scoped reads may precede durable graph storage with an explicit
unavailable state. Final architecture/security/visual reviews found no remaining
high/medium blocker in this documentation scope.

## Validation of this change

Only ten new Markdown files under this directory changed. Relative document
links, frozen source-link paths/line bounds, fenced blocks, exact reference
archive/image hashes and unchanged repository brand SVGs were checked;
`git diff --check` passed. No application test/build, SQL, live authorization,
provider benchmark or application screenshot comparison was run or claimed.
Phase D acceptance tests and screenshot matrices are specifications for later
implementation, not completed evidence.

## Findings that determine the plan

1. The creative foundations exist: typed Canvas wiring and validation, React
   Flow board, Film scenes/takes, shared Film autosave and conflict recovery,
   Timeline, editor, library, billing and MCP. Reuse them.
2. Sketch graph state is browser-local and lacks Film identity. Film Timeline
   reads durable Film state. A view toggle does not make them synchronized.
3. PR793 contains Timeline correctness/confirmation/mobile repairs not present
   in the frozen main. Review and reconcile these before overlapping paid
   Timeline integration; do not recreate them under a redesign label.
4. Existing `ViewModeToggle` changes Mobile/Desktop layout, not Owner/Personal
   mode. Add the owner-authorized destination only inside the reused top-right
   N account dropdown; keep the existing device preference distinct.
5. Current operator access includes platform owner/admin; the requested Owner
   Command is narrower. Menu hiding cannot replace server/DB authorization.
6. Current owner customer payment totals are Paddle-specific gross facts, not
   complete multi-provider revenue or net profit. Preserve provenance and
   incomplete states instead of filling financial charts with mock figures.
7. MCP API-key and OAuth capability sets differ. Film browser-session RPCs are
   not safe OAuth adapters. All seven models opened by 0173 are `web_only`;
   broadening MCP discovery does not grant their API distribution rights.
8. Mockup customer sidebars, large mode switches, Stripe/SOC 2/GPU claims and
   illustrated metrics conflict with source/product rules. Preserve the visual
   language, not those claims.

## Product decisions carried forward

- Exact repository N and wordmark assets remain byte-identical. No tracing,
  replacement lettering or generated logo assets.
- Ordinary users and owner-in-Personal-Studio share the same customer screens,
  creative components, project identity and billing operations. No investor role,
  owner-specific editor fork, second graph model or second ledger.
- Dependencies describe creative inputs; scene order describes playback. Layout
  movements do not automatically change either meaning or authorize spending.
- One master prompt can propose a reviewable draft. It cannot approve itself,
  execute all cards, publish, send comments or make payments automatically.
- Existing quote/hold/capture/release, idempotency, approval and no-substitution
  rules remain authoritative. Unknown, gated and unavailable remain visible.
- Scope this premium visual work to the signed-in app and its portals. Do not
  accidentally redesign public landing, pricing, login or legal surfaces.

## Approval boundary

The uploaded brief states: **“PHASE D — IMPLEMENT ONLY AFTER APPROVAL”** and
**“No server, production, schema or application changes before owner approves
an implementation scope.”** These instructions are consistent with the owner's
existing production restrictions. This package makes that scope concrete; it
does not infer approval from the request to distribute planning work.

Recommended first implementation scope is D1 in the implementation proposal:
signed-in visual tokens and the reused N account menu, with exact brand and
existing actions preserved, no schema, new paid executor or owner financial API.
Owner Command availability remains gated until the narrower owner contract is
verified. Durable graph and MCP scope changes require their separately listed
backend/security approvals. No implementation approval implies merge/deploy.

## Relationship to existing documents

This package records the delta and acceptance contract around existing
[Studio IA](../../studio/STUDIO_IA.md), [Planner design](../../studio/PLANNER.md),
[Film Studio](../../FILM_STUDIO.md), [MCP](../../MCP.md),
[visual identity](../IDENTITY.md), [type](../HUMAN_TYPE.md) and
[color](../COLOUR.md). Their implemented source remains authoritative for what
exists. The new reference pack supersedes conflicting older visual proposals
for this proposed signed-in redesign only. Update those design documents in
the eventual implementation PR, rather than inventing a competing design system.

AI Brain [P0 docs PR795](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/795)
is a separate draft dependency/reference, not merged source or authorization to
start AI Brain P1. Private pricing/supplier comparison artifacts from this chat
are not published as customer-facing values by this package.
