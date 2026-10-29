# Nightshift Orchestrator — Integration gate design

## Codex task handoff

Codex SDK and `codex exec` can programmatically run a **separate local/CI Codex agent**. This repository does not have a verified API for messaging the user's existing mobile Codex Cloud task. Its shared URL and thread ID are not a supported authorization grant.

**Current implementation**: an explicit `codex_task` handoff request is validated against real GitHub CI status and intentionally blocked with `codex_auth_and_budget_not_configured` even after approval. No API keys are stored, no usage is charged and no Codex task is run.

Enabling programmatic execution requires verifying authentication, plan limits, SDK sandbox, isolation, run cancellation, per-run costs, repository scopes, idempotent task leasing and owner-approved budget. Never infer that a ChatGPT subscription covers API usage.

## Deployment handoff

A manual `deploy` workflow checks source PR state but **cannot actually deploy**: code requires a verified deployment route, production environment reviewers and branch protection, explicit owner release authorization, artifact digest pinning, health checks and rollback protocol. CI PASS by itself is not a release authorization. Production remains untouched.

The handoff workflow checks out only trusted `main`, never PR code. GitHub permissions are read-only. It has no SSH credentials, deployment keys, or network calls to Hetzner. It cannot activate a deployment.

## Current milestones

- v0.1: hourly read-only GitHub watcher.
- v0.2: event-based PR/CI status watcher.
- v0.3: typed Codex/deployment handoff requests and fail-closed safety tests, **neither execution path enabled**.

Further enabling either execution path requires concrete, verified infrastructure details and owner-specific financial and deployment permissions.
