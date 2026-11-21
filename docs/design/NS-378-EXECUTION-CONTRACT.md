# NS-378 — review-only Brain execution state seam

This is an unwired pure local contract, not another executor, queue, job status migration,
dispatch permit, approval validator, billing policy or provider-selection layer.

Source base: commit `0940d532d4276f049dfeef4c31c8b99106c5297a`, tree
`9ea8639610093a7bd09cd61f1c78124641c02714`. Fresh isolated copy:
`/workspace/ns-378-brain`; original and prior lane checkouts are untouched.

## Architecture and already-open work

Read-only review of [#795](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/795),
head `6c61d962086e1940b9c52ad27c5b6a72991f9605`, architecture blob
`ea23c531796ee258e87fdc02b038c0df34ae72ff`, especially sections 2, 5 and 7:
one planner/executor; existing workers stay authoritative; leases/fences;
unknown provider outcomes cannot authorize another purchase. #795 is an open draft
specification based on f985b3af, not installed runtime code or release authority.

Open-PR inventory was reviewed before editing. #803 is gathered Studio CI work;
#802 presentation/recovery; #799/#800 design/UI; #795 architecture; money/voice
work remains separate. The potentially overlapping #651 head
`9ba7daa02c2c2ab53c1e8dab69786cdeb74c0cd7` was inspected: manual Ads concepts,
preview-only, no equivalent step execution validator. No claim is made about
unpublished parallel work or a deployed system. No older PR source was applied.

## Reuse and safe seam

| Exact baseline source | Existing behavior | Local contract use / limitation |
| --- | --- | --- |
| `command-center/lib/agent-graph.ts:59,72` | Closed workflow schema, known node types, DAG inspection and topological order | Inject/reuse `inspectWorkflow`; no new planner or node registry. Existing approval topology rules remain untouched; this validator grants no approval. |
| `command-center/components/studio-canvas/nodeState.ts:41` | UI derives job state, distinguishes unread/unknown, exposes completed output only | Presentation is not the authoritative attempt state; do not infer provider failure from a failed read. |
| `command-center/lib/creative/studio.ts:1166` | Existing active creative job statuses, including provider_pending | Keep domain status vocabulary; outcome_unknown here is an additional projection, not a stored creative_jobs status. |
| `modules/creative_worker.py:18-49,423,593` | Injected queue/adapter, task-id resume, submitting recorded before submit; ambiguous acceptance must not resubmit | Future trusted adapter projects these observations into the validator. No worker changes or submit/poll calls here. |
| `modules/creative_worker.py:1064` | Same-task poll, bounded errors and deadline | Reuse existing reconciliation behavior; do not reset attempt/purchase on a read error. |
| `docs/studio/PLANNER.md:667-764` | Proposed server executor, bounded known-outcome retries, reconcile before resubmit | Common execution/step-state boundary is missing; this draft validates projections only, not the proposed executor. |

The shared prospective seam is after existing workflow inspection and before an
existing worker's queue advance/dispatch: a trusted adapter supplies current immutable
plan/input revisions, task/org binding, fence, exact step set and known provider
observations. `inspectExecution` checks the read projection. `inspectStepTransition`
checks one proposed state change against the same scope. Nothing is executed.

## Contract

Every step has status, monotonically checked attempt number, nullable opaque provider
task identity, explicit outcome knowledge and failure classification. The full snapshot
contains every DAG node exactly once. Active/completed dependents require completed
predecessors. A running attempt begins only at queued or known technical failure and
increments by one; completed/cancelled cannot restart. Caller must supply positive
maximum attempts, absolute deadline and synthetic/current time; there are no defaults.
An exact replay is inert and does not increment attempts. Changes to org/task/revisions
or fence, multiple-step jumps and provider identity replacement within an attempt fail.

`outcome_unknown` is explicit and cannot restart. A known task may resume reconciliation
without a new attempt, even beyond the new-attempt deadline. Unknown-to-known terminal
or pending states require externally verified readback supplied by the future adapter;
this module neither manufactures nor verifies that provenance. It does not interpret
HTTP 5xx, timeouts or customer hold release as evidence of nonacceptance.

Failure classification is trusted input: only `technical` is retry-shaped; a known
`terminal` refusal is not. This is a necessary consistency check, never sufficient
provider authorization. Every verdict includes `dispatchAllowed: false`, including ok.
No real retry count/deadline, provider/model, financial amount or billing rule is chosen.

## Integration blockers and scope limits

- Authoritative adapter mapping current domain observations to known/unknown and
  technical/terminal states is not implemented. A database failed row alone is insufficient.
- Durable current snapshots, atomic compare-and-swap/fencing, event replay identity and
  complete attempt history remain external requirements. The pure pair validator cannot
  prove history, caller identity or that two reviewers saw the same live state.
- Existing broker/dispatch controls and independently reviewed approval/payer/cost
  prerequisites must remain at the actual effect boundary; this lane implements none.
- Parallel DAG scheduling, queue fairness, lease acquisition, in-flight cancellation,
  provider lookup and persisted idempotency are not implemented or tested.
- This is a minimal projection: queued cancellation and the full job/Brain task lifecycle
  are not modeled. Injected DAG inspectors are trusted deterministic validators.

The included tests use synthetic data and injected time/policy only. No worker, DB,
provider, generation job, migration, billing, memory or reporting path is changed.
