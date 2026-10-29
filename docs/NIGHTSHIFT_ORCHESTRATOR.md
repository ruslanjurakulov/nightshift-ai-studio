# Nightshift Development Orchestrator — v0.1

**Mode: READ_ONLY**. This is a GitHub PR/CI status watcher, not a Codex Cloud session controller. It creates no issues, commits, messages, PRs, or automated Codex tasks. It never merges, deploys, calls paid AI APIs, or contacts Hetzner/Supabase. Its first tracked PR is #647; manual runs accept another PR number.

## Activation

This monitoring-only workflow is proposed through a **draft PR**. Scheduled GitHub Actions run from the default branch, so automatic hourly checks remain inactive until reviewed and merged. After activation, cron `17 * * * *` checks the designated PR hourly. GitHub may delay schedules.

## Behaviour

1. An ephemeral GitHub-hosted Ubuntu runner gets a minimal read-only GitHub token.
2. The Python program reads PR metadata, head SHA, check runs and workflow runs.
3. The classifier produces MERGED, CLOSED, REVIEW_PENDING, NO_EVIDENCE, CI_FAILED, CI_RUNNING, CI_UNKNOWN or REVIEW_READY.
4. It writes a status JSON artifact and a job summary, with a recommendation.
5. **REVIEW_READY does not establish SQL ownership, RLS, concurrency or gateway acceptance.** Human review is required.

## Limitations

- This version tracks PR #647 on its schedule; manual runs can specify a different PR.
- GitHub CI status is not a Codex task-completion signal until task results have been published on GitHub.
- It does not read or message the user's existing mobile Codex Cloud session.
- Automated Codex execution requires a supported authenticated integration and explicit billing/usage approval. Agents API has separate usage costs; **do not enable it under a $0 budget**.
- No automatic GitHub writes, merge, approvals or deployment.
- Scheduled runs may be delayed/skipped under GitHub load.

## Verification

```bash
python3 -m unittest discover -s tests -p test_nightshift_orchestrator_monitor.py
python3 -m py_compile tools/nightshift_orchestrator_monitor.py
```

## Safety requirements before autonomous task execution

Require explicit owner approval, validated Codex API integration, budget controls, scoped credentials, prompt-injection isolation, rate limiting, durable task state and idempotency, stop switch, test coverage and human review. Preserve the existing Nightshift publish gate and production credentials.
