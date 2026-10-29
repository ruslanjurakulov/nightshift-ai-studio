# Nightshift Codex Cloud dispatcher

This workflow uses OpenAI's documented GitHub PR comment integration: `@codex fix the CI failures`. It does **not** reuse mobile Cloud sessions, have an API key, run Codex locally, or spend on API usage. GitHub Codex integration must be enabled for this repo; whether comments authored by `github-actions[bot]` trigger Codex is **unverified** and must be tested before calling dispatch fully operational. **Evidence (2026-10-29):** a user-authored @codex command on PR #647 received a reply from chatgpt-codex-connector[bot]: `To use Codex here, create an environment for this repo` (GitHub comment id 6504451541). This indicates an actual missing **Codex Cloud (Legacy)** environment for GitHub PR mentions, even if a newer mobile `Base Environment` already exists. Configure the legacy environment at https://chatgpt.com/codex/cloud/settings/environments (signed-in user), select and connect `ruslanjurakulov/nightshift-ai-studio`, then repeat ONE owner-authored @codex test. The assistant cannot complete the user's ChatGPT account UI setup from the GitHub connector.

## Activation
The workflow lives on a feature branch in draft PR. It only runs after merge to default `main` **and** setting the GitHub Actions repository variable `NIGHTSHIFT_CODEX_DISPATCH_ENABLED=true`. The default, when unset, is OFF. Do not enable until the legacy GitHub integration environment responds to a real user-owned @codex PR comment. It listens to failure of allowlisted CI workflows on PR events. It posts a fixed instruction to exactly one same-repository PR belonging to `ruslanjurakulov`, where the commit SHA equals the failing run SHA. It cannot run on forks or unlinked CI runs. It uses only GitHub read permissions plus `issues: write` for PR comments. No SSH access, secrets or production operations.

## Limits and safeguards
- At most two dispatcher comments per PR, including later SHAs: prevents runaway automatic retries.
- Each run ID and SHA marker is idempotent, best-effort; concurrency handles same-SHA duplicate actions. Race across different head SHAs can still make back-to-back comments; maximum two remains conservative.
- Input PR text, comments, logs, artifact content never enters the Codex instruction. No checked-out fork code.
- No automatic approval, merge, deployment, payments or production environment access.
- A Codex task can produce modifications that must pass required CI and human review.
- GitHub workflow-run metadata may omit PR association; fail-closed (no comment).
- Pagination handles only first 100 issue comments; review if PR has >100 comments.

## Test
Run: `python3 -m unittest discover -s tests -p test_nightshift_codex_dispatcher.py`.
Need a real Actions run and observe whether Codex reacts to the bot comment before claiming end-to-end PASS. If not, prefer a human-authored `@codex` command or an explicitly approved supported integration; do NOT use personal tokens to impersonate humans.
