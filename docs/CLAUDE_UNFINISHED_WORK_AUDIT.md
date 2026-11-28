# Requested Claude unfinished-work audit — evidence register

Status: **read-only findings; no fixes, PR merges or operational changes**.
Checked: 2026-11-15 (Asia/Tashkent). Local source baseline:
`f985b3afd371c0677357670da436ef2074fdb036`.

## 1. What can and cannot be established

The owner asked for work Claude left unfinished when its limit was exhausted. The
repository, current open PRs, PR descriptions and available discussion were inspected.
No private Claude session transcripts or account usage records were available. Searches
for `usage limit`, `limit reached`, `session limit`, and `unfinished` in repository issues/PRs
returned no matching records in the queried results. This does **not** prove no interruption
occurred. It means the cause cannot be established from the returned evidence.

Accordingly, **none of the items below is labelled proven Claude-limit interruption**.
They are verified open work, partial implementations, deliberately gated features or
owner/operations prerequisites. Several PR bodies identify Claude Code; other PRs concern
Codex or dependency bots. Authorship and reason for stopping must not be conflated.
GitHub CI timeout limits, provider quota and a Claude account usage limit are different.

The old audit checkout `e02c884a` was stale. Remote main was fetched and the separate
docs worktree fast-forwarded before this audit. The original checkout was not changed.
No open PR head was merged. PR-authored test numbers below are not our test executions.

## 2. Open functional PR inventory

The GitHub search returned 14 open PRs: 12 functional/test/design PRs below and 2 dependency
updates in section 4. The 12 functional PRs were individually read with metadata and were
open, draft and not merged at inspection. Their state can change after this snapshot.

| Priority / PR | Work remaining or release blocker | Evidence and next bounded action |
| --- | --- | --- |
| P0 — [787: Paddle sandbox allowlist](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/787) | Prevent signed sandbox purchases from creating usable entitlements for non-test orgs | PR reports a reproduced high billing issue. Review checkout and webhook allowlists, environment separation, subscriptions/API top-ups and replay tests; live exposure is unverified |
| P0 — [750: concept-thumbnail holds](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/750) | Align DB, series/MCP and worker holds with generated thumbnail images | PR reports a 75.00-credit hold vs 82.20 metered example, 7.20 uncovered, using fixture prices, not a live tariff. Coordinate pending jobs and database-before-worker order; reuse patch rather than rewrite |
| P0 — [786: failed/refused job cap](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/786) | Limit customer-error repetition that can cost the platform after a hold is released | Review closed error list, workflow admission and concurrency; latest title says migration 0177, older body text says 0175. Coordinator must resolve current migration allocation and guards, not copy a stale number |
| P0 before Timeline release — [793: Lens fixes missed by 790 merge](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/793) | Three reported High findings: chosen/measured shots, paid-start confirmation, mobile reorder; additional stale-response/audio/UI fixes | PR says fixes were pushed after #790 merged. Review the current diff and tests; do not assume merged #790 contains later fixes |
| P1 — [794: voice render budget/cleanup](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/794) | Correct 600-second render timeout, remove partial mp4 on interruption, name missing ffprobe | Follow-up to merged engine #769; coordinate timeout use in #771 adapter. PR reports 50 tests; not rerun here |
| P1 — [771: Voice-to-video Studio integration](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/771) | Engine-to-product integration: capability/worker/image prerequisites, source validation, quotes, library result, UI, probe/price/opening | Ships dark; no registry row/price enabled by merge. Worker image build, actual host cgroup memory and long render capacity still unverified. User cancellation does not yet interrupt an active render |
| P1 — [783: ElevenLabs Scribe transcription](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/783) | External STT integration on top of #771, terms gate, exact request/errors and Uzbek comparison | Preserve reported owner choice of external STT. No actual Uzbek WER comparison made; consented reference recordings, OEM/Scale/training terms review and explicit benchmark budget needed. Do not silently fall back to Whisper |
| P1 — [647: disposable Supabase harness](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/647) | Phase 2B.1G authorization tests not begun; broad CI/current full-chain parity and production equivalence not established | PR records separate full-chain and executor-identity evidence. Subset success is not full-chain security success. Ownership/RLS/concurrency/gateway tests remain UNRUN; keep draft |
| P2 — [739: public model pages](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/739) | Build and 390/1440 visual checks are explicitly unverified | Review availability/copy/source-of-truth drift; models shown in samples must not be advertised as available without current DB eligibility |
| P2 — [649: event orchestration/handoffs](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/649) | Verify actual workflow names, event security, supported auth/budget and release controls | Does not implement a product Brain or message a mobile session. Treat automated execution as separately authorized, not a prerequisite to read-only Brain planning |
| P2 — [650: bounded Codex dispatch](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/650) | End-to-end evidence that the intended bot comment really triggers the supported Codex flow | PR explicitly says unproven. Discussion includes a connector request to create an environment, not evidence of task completion; do not send new comments/tasks during this audit |
| Review for supersession — [651: Ads Studio concept workspace](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/651) | Old preview-only proposal needs reconciliation with now-merged Ads Factory/brand-scan architecture | No production generator claim. Reuse current `ADS_FACTORY.md`, existing brand kits/scan/jobs/editor; do not implement another independent Ads Studio from the old branch |

These are follow-up work recommendations, not authorization to merge, deploy, apply
migrations, probe a model, alter billing or run paid comparisons.

## 3. Merged work that remains partial or intentionally gated

| Area | Already complete / source | Actual remainder and classification |
| --- | --- | --- |
| Studio Planner | [Design](studio/PLANNER.md), merged #791 | Explicitly design-only: server catalog/health TTL, template validation, planner, single gate and executor remain to build. Brain must extend this design, not create a competing plan system |
| Film Studio | [Core/drafts/money/canvas/timeline](FILM_STUDIO.md), 0166/0171 and #790 | Film P3 worker/orchestration absent; assembly wiring/host measurement and paused/cancelled recovery gates remain. A price row alone cannot enable a missing worker |
| Voice 2D engine | [Voice explainer](VOICE_EXPLAINER.md), merged #769 | Engine exists; Studio integration and Scribe are open #771/#783, render fixes #794. Do not recreate engine because the product path is not live |
| Series Factory | [S1–S3/caps](SERIES_FACTORY.md), 0127 | Implemented but `request_series_plan` still ungranted. Cancel/restart, semantic originality, per-run storyboard override, planning cost coverage and S4 format/episode propagation remain; anti-abuse/availability gates precede grant |
| Owner safety | [Owner RPC path](../command-center/lib/server/owner-rpc.ts), 0107 | Guarded app path exists behind default-off flag; legacy direct-path closure and verified AAL2 rollout remain. Ledger language saying the app path is absent is stale |
| Film result projection | [BR-790-01](security/LEDGER.md) | Route now returns an allowlist, but direct `start_film` member-safe DB JSON follow-up is recorded pending. Not evidence the whole Film module is missing |
| LLM abstraction | [providers](../modules/providers.py), [structured output](../modules/structured_output.py) | Shape-only provider protocols and Gemini opt-in JSON spike do not provide a working local/provider-independent LLM runtime |
| User reporting | Existing [Results dashboard](RESULTS_DASHBOARD.md) | Immutable daily/weekly/monthly user reports and intelligence PDF/CSV export missing. Invoice PDF generation is a separate implemented concern |
| Memory | Existing approved [learning memory](../modules/learning_memory.py), Channel DNA/style/character records | General private-user retrieval/provenance/expiry extension remains; existing learning loop must not be rebuilt |

The old [gap analysis](product/GAP_ANALYSIS.md) says it is superseded. Its references
to `OWNER_TODO` do not resolve to a tracked matching file at this baseline. Old “missing
router/inbox/MCP/IR/QC” rows are not a reliable unfinished-work list. Current code and
subsequent migrations take precedence.

## 4. Separate operational prerequisites and dependency updates

- [PR 665](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/665): Actions dependency
  update; [PR 653](https://github.com/ruslanjurakulov/nightshift-ai-studio/pull/653): proposed
  Python 3.11 to 3.15 base-image update. Both were in the open search results, not individually
  reviewed here. They are dependency proposals, not proof of Claude unfinished feature work.
- Actual migration history, feature flags, owner MFA enrollment, production environment
  branch/reviewer protections and secret reach require an approved operational check.
  Repository declarations do not prove current server configuration.
- Vendor terms, OAuth reviews/scopes, model probes/prices and payment-provider readiness
  are release prerequisites. No live payment readiness is inferred from a sandbox integration.
- CPU/RAM benchmarks, Film media-worker assembly measurement and Voice long-render cgroup
  memory remain host evidence obligations. Dev-container timing/PSS is not server capacity.
- #647's documented full chain ended at 0128; current main reaches 0174. Reuse its harness,
  but a 113/113 historical chain result cannot certify the enlarged current chain.

## 5. Recommended continuation order

1. Reconcile exact current diffs and migration order for billing #787/#750/#786, owner
   legacy access closure and Timeline #793. Keep releases gated until accepted.
2. Resolve resource measurements and voice follow-ups #794/#771/#783 in their existing
   branches, preserving the owner's provider choice and no-fallback rule.
3. Complete #647's scoped security evidence before relying on it as an authorization proof.
4. Implement the existing Studio Planner design through the approved Brain roadmap, with
   shared catalog/gate/executor and Film/pipeline integration; do not duplicate the work.
5. Reassess old #649/#650/#651 against current needs and architecture; keep, supersede or
   close only after an explicit owner decision. This audit does not change their status.

Each continuation needs its own base SHA, accepted scope, dependency and verification
evidence. “Open”, “dark”, “not built”, “unverified” and “waiting for owner” stay distinct.
The [P0 risk roadmap](IMPLEMENTATION_ROADMAP.md) maps the relevant blockers to concrete
implementation packages; P1 has not started.
