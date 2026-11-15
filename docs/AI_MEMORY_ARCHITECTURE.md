# AI Brain memory architecture

Status: P0 design only, 2026-11-15; source baseline `f985b3afd371c0677357670da436ef2074fdb036`. This document proposes contracts and acceptance criteria; it creates no tables, indexes, policies, migrations, services, or scheduled jobs. Runtime behavior and existing approvals remain unchanged. Implementation requires a separately reviewed change.

## Existing sources and reuse

Memory is a controlled view over Nightshift's existing records, not a second database of channel facts.

| Existing component | Reuse | Current limit to preserve or resolve |
| --- | --- | --- |
| `modules/learning_memory.py`, migration `0014_learnings.sql` | Measured evidence becomes pending proposals; only approved learnings add approved-learning context to topic/script prompts. Decided proposals are not silently rewritten. | Existing feedback scores, retention context and experiment choices also influence prompts without this approval layer. Do not describe all current learning as human-approved. |
| `command-center/lib/memory.ts` | Derives visible memory from topic performance and feedback signals without separate persistence. | Derived patterns are observations, not approved policy or causal explanations. |
| `modules/channels.py::ChannelContext` / `ChannelDNA`, migration `0056_channel_dna.sql` | Existing channel identity, tone, language, format, voice and style references. | Legacy default organization behavior must never resolve a missing Brain tenant. |
| Migration `0047_style_kits_characters.sql`, `modules/creative_style.py`, `modules/dna_render.py` | Existing style kits, characters, descriptions and owned asset references. | Pipeline prompts currently carry descriptions; Studio adapters may support reference images. A reference capability must not be invented or silently dropped. |
| `modules/state_store.py`, feedback/retention/experiments, analytics snapshots | Generation/performance history and evidence for proposals. | SQLite/history files are execution persistence, not an independent authorization authority. Every read needs explicit channel and organization scope. |
| Existing media library, Video IR, creative jobs and cost records | Successful prompt/result provenance and owned artifacts. | A successful generation is not evidence of successful audience performance; an output may have unknown rights or cost. |
| Film project core (`0166_films_core.sql`), film money (`0171_films_money.sql`), Studio canvas/timeline | Project, scene, take and generation dependencies remain their existing canonical records. | Memory must not create another film/job graph. `docs/studio/PLANNER.md` is a merged design, not an implemented generic planner/executor; extend its exact-plan gate design with the memory dependency contract below. |
| Migration `0018_organizations.sql`, channel-scoped RLS | Current tenant relationships and access checks. | Existing platform-admin helpers and service-role reads are broader than a Brain task's authority. They must not become Brain capabilities. |

Extend existing sources with reviewed version/provenance metadata where needed. A future private preference or approved brand-fact record is justified only when no existing source fits. A search index is a disposable projection, never another source of truth. Start with bounded relational retrieval; embeddings are optional after measured retrieval quality and resource costs justify them.

`docs/CHARACTER_STUDIO.md` and migration `0137_character_studio.sql` describe a separate, gated character-swap workflow. It reuses owned references and consent records; it is not the same capability as persistent character memory. The Brain must not activate it, expand consent, or infer a right to clone a real person from a character description.

## Identity and visibility

The trusted backend derives a task capability containing organization, acting user, channel where applicable, purpose, allowed source kinds, read/write actions, expiry and task identifier. Values asserted by model text, comments, uploaded files or tool arguments cannot broaden it. Missing or ambiguous tenant identity fails closed; there is no default-organization fallback.

| Scope | Visibility and approval |
| --- | --- |
| User-private | Only the owner and a task acting for that owner. Membership in the same organization does not share private preferences, drafts, notes or retrieved excerpts. Sharing creates an explicitly approved scoped publication; it never changes the private original implicitly. |
| Channel | Explicitly designated workspace-visible channel strategy and channel-owned evidence, readable only by authorized channel/workspace members and tasks scoped to that channel. The UI must state the sharing scope. A channel identifier alone grants nothing. |
| Brand/style/character | Reuse organization-owned records only for the task's authorized brand/channel purpose. References must resolve to live assets of the same organization. A brand record does not expose its author's private memory. |
| Generation | The authorized participants may inspect a plan's pinned inputs and output provenance under that project's access policy; never attach unrelated private context to a shared project. |
| Platform operations | Aggregate counters and sanitized health signals only. Platform-admin status does not authorize the Brain to retrieve customer content or impersonate users. Any exceptional human support access belongs to a separate audited process. |

The policy broker enforces scope before SQL retrieval or search ranking and again before delivering results. Brain containers receive neither a service key nor arbitrary SQL access. Search, caches, deduplication, reranking and exports include organization, visibility scope and applicable user/channel identifiers. Global nearest-neighbor retrieval followed by filtering is prohibited. Unauthorized identifiers return a non-disclosing refusal.

## Logical memory contract (proposed, not a migration)

An envelope references its canonical source rather than duplicating it:

```text
memory_id, source_kind, source_id, source_revision, content_digest
org_id, scope(user_private|channel|organization), owner_user_id?, channel_id?
purpose, sensitivity, visibility_grant_revision
status(proposed|approved|rejected|superseded|revoked|expired)
created_at, observed_at?, valid_from?, expires_at, delete_after
proposed_by_task?, approved_by?, approved_at?, approval_revision?
evidence_refs[], provenance, source_trust, outcome_confidence?
supersedes_id?, derived_index_refs[]
```

The combinations of scope and identifiers are validated by the backend. `owner_user_id` is mandatory for private records; a channel record must resolve to the named organization. Approval records bind the exact content digest, revision, visibility and intended uses. They cannot approve a moving pointer such as "latest channel strategy." Brand facts additionally name their evidence, effective dates and prohibited claims; a comment is not an authoritative brand fact.

Approved content is immutable by revision: corrections create a new version and a new decision. Rejection, revocation or expiry prevents new retrieval. Approval never raises a tool permission, changes a publish gate, extends a spending limit, or approves future unrelated jobs. Model weights and application code remain immutable to the Learning Agent; memory improvement is proposal/review/retrieval only.

## Retrieval and injection isolation

1. Authenticate the task, verify current membership and its bounded capability, then resolve allowed sources. Never trust user-editable profile metadata as authorization.
2. Filter by tenant, private owner/channel visibility, approved-use status, source rights, validity and purpose before ranking. External observations may be retrieved as labeled evidence, but cannot enter the approved-instruction lane.
3. Return bounded excerpts with source IDs, revision, dates, trust labels and evidence links. Preserve uncertainty and contradictions. No source means "not available," not a fabricated memory.
4. Place retrieved text in a delimited data context distinct from system/developer instructions. Comments, web pages, filenames, transcripts, model summaries and reference descriptions remain untrusted data even after classification or indexing. Approval of their use is not an endorsement of embedded instructions.
5. Validate structured output independently. The policy engine authorizes each proposed tool action from the task capability and exact plan; the model cannot request secrets, arbitrary URLs/files/SQL/shell access, or treat a retrieved command as authority.
6. Enforce context/token limits, maximum retrieval counts, timeouts and per-tenant inference budgets. Audit source references and decisions without logging private text, secrets or raw prompts.

Use adversarial retrieval fixtures in the isolated test environment: forged org/channel IDs, cross-user private notes in one workspace, hostile comments, injected style descriptions, stale membership, revoked approvals, malicious citations, and a search index with incorrect tenant labels. A corrupt index must not bypass canonical-source authorization.

## Plan dependencies and approval invalidation

Before approval, resolve memory into a generation-specific snapshot containing the exact permitted excerpts or immutable revision references plus their digests, provenance and visibility. Include that snapshot's digest in the canonical generation plan hash alongside models, settings, prompts, assets, prices and policy versions. An organization-visible plan must omit private context unless the owner explicitly approves its disclosure.

Immediately before paid execution, the backend checks the approved plan hash, approval expiry, dependencies, current rights and budget. A changed memory revision, content digest, approval/visibility grant, or validity state that changes or revokes the context resolved into the approved plan invalidates that approval and requires a new plan/quote/approval. The worker cannot substitute the latest strategy, character description or prompt-library entry after confirmation. Deleting or revoking a pinned source blocks further use; reproducibility cannot override erasure or access revocation.

Unrelated newly proposed memory does not mutate an existing pinned plan. A task resumes with its pinned authorized snapshot, subject to the checks above. New audience feedback becomes evidence for a future plan, not permission to rewrite a running one. Publishing still uses the repository's existing exact-cut approval and publish gate independently.

## Evidence, confidence and learning lifecycle

Record the channel, video/generation IDs, observation window, metric definition, missing-data flags and comparison baseline. Retention observations include sample counts, distinct videos, comparable publication ages and any experiment assignment. Existing `learning_memory.sample_confidence` uses `n / (n + 3)`: it is an evidence-size weight, not a significance test or probability of truth. Existing retention/experiment evidence floors remain in force.

Keep `source_trust` separate from `outcome_confidence`. An official analytics source can accurately report a small, inconclusive sample; a large comment sample can still be manipulated. Unknown confidence remains null. Correlation such as "videos with this opening had higher retention" must not become "this opening caused retention to increase" without an appropriate experiment. Successful prompt libraries preserve model/version/settings/rights/result links and measured cost when known; they do not fabricate ROI, audience lift or causal success.

Lifecycle: observe → bounded evidence extraction → deduplicated proposal → authorized human decision → versioned approved retrieval → expiry/review/revocation. The agent may propose updates, never approve its own strategy or renew an expired approval. Conflicting proposals remain visible with evidence instead of overwriting a decided record.

## Retention, expiry and deletion

The following are proposed maximums for *new Brain-managed projections and memory*, not claims about current storage or a change to existing financial/audit retention. Provider terms, consent withdrawal or a shorter workspace policy always shorten them. No Brain content retention is unlimited. A longer period needs a separately documented owner decision, purpose, lawful basis and user-facing policy before rollout.

| Data class | Proposed maximum |
| --- | --- |
| Inference context/cache and temporary retrieved excerpts | 24 hours; clear at task end where possible |
| Raw external-content extraction cache and unapproved proposals | 30 days |
| Approved personal/channel/brand/character memory and prompt-library annotations | 365 days from approval; review at most every 90 days; human renewal creates a new approval/version |
| Audience-derived analytic aggregates used as memory | 365 days from observation, subject to platform retention/deletion rules |
| Generation-specific pinned memory content | 90 days after job completion; earlier on erasure/revocation. Keep non-content dependency hashes only under the separately approved audit policy. |
| Brain decision/security audit metadata without content | 365 days unless a separately established legal/security policy requires another period |
| Deleted Brain content in backups | Expire within 30 days; restore must replay deletion tombstones before serving retrieval |

Authorization validity is checked on every retrieval and execution, regardless of cleanup timing. TTL is not access control. Approved content expires no later than its class maximum and any earlier evidence/license/consent expiry. Retention beyond approval expiry cannot make content retrievable again. Before implementation, reconcile these proposed limits with current media, accounting, platform API and backup policies; do not silently purge existing records under this design document.

Deletion tombstones canonical entries, revokes dependent approvals and removes excerpts, embeddings, caches, prompt-library derivatives and exported Brain artifacts under Nightshift's control. Unlink shared references only after checking ownership; deleting a private note must not delete another user's asset. Account/channel/workspace deletion enumerates all related projections and pending jobs. Active tasks stop before the next tool action; cancelled or revoked context must not survive a retry. Minimal non-content audit metadata may remain only under an explicit applicable retention policy. Already delivered external artifacts require an honest account of what Nightshift can delete and any platform deletion API used by an authorized worker.

## Implementation acceptance gates

- A task cannot retrieve another tenant's content or a teammate's private memory, including through platform-admin helpers, caches, exports and search results.
- Current channel membership, purpose and exact source visibility are checked at retrieval and execution; missing identity fails closed.
- Existing learnings, Channel DNA, style kits, characters and history are reused; duplicate canonical memory stores are absent.
- Changed resolved memory, revoked visibility, expired approvals and erased sources prevent use of an old plan approval.
- External instructions cannot authorize tools; memory writes cannot mutate code, weights, schema, production configuration or permissions.
- Observations retain evidence, trust, sample counts and uncertainty; retention correlation is not presented as causality.
- Expiry, deletion, derivative cleanup and backup restore behavior are demonstrated in an isolated environment before any customer rollout.

Related design boundaries: `AI_BRAIN_ARCHITECTURE.md`, `AI_AGENT_REGISTRY.md`, `AI_SECURITY_POLICY.md`, `CHANNEL_INTELLIGENCE.md`, `AUDIENCE_INTELLIGENCE.md`, `REPORTING_INTELLIGENCE.md`, and `IMPLEMENTATION_ROADMAP.md` (P0 document set).
