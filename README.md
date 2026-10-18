# Nightshift

Nightshift makes YouTube videos for you. You give it a topic (or let a channel
choose one); it researches, writes, narrates, edits and renders the video. **You
approve before anything is published.** It is sold as a web app, a public API,
an MCP server and a CLI, paid for with credits.

Live site: <https://nightshift-ai.studio>

## Parts

```
main.py, modules/        the video pipeline (Python): topic, research, script,
                         fact-check, voice, media, captions, thumbnails, render,
                         publish gate, YouTube upload
tools/                   scripts the workflows and the worker call
command-center/          Next.js app: the public site (/, /pricing, /docs, /mcp)
                         and the signed-in app (/{channel}/...)
supabase/migrations/     Postgres schema, RLS and SQL functions (additive; applied on merge)
docs/sql/                owner-applied scripts: one-time data clean-ups and rollbacks, never migrations
packages/cli/            @nightshift/cli, a command-line client for the public API
skills/                  Agent Skills that teach an AI agent to use the CLI and MCP
video-engine/            Remotion scene renderer (off by default)
deploy/                  Docker Compose, Caddy, and the SSH deploy script for the server
tests/                   Python tests, plus tests/security (the security lab)
docs/                    guides, design records, the security ledger
```

## Ways in

| Door | For | Docs |
| :-- | :-- | :-- |
| Web app | people making videos | `command-center/` |
| Public API (`/api/v1`) | your own code; prepaid developer balance | [`docs/API.md`](docs/API.md), `/docs/api` |
| MCP server (`/api/mcp`) | Claude, ChatGPT, Cursor and other assistants; sign in with OAuth (paid plans, spends site credits) or use an API key | [`docs/MCP.md`](docs/MCP.md), `/mcp` |
| CLI | scripts and terminals; not published to npm yet | [`docs/CLI.md`](docs/CLI.md) |

The MCP sign-in and the CLI page are behind flags (`MCP_OAUTH_LIVE`,
`DEV_CLI_PAGE`); only the exact value `1` turns them on.

## Money

Plans (Free, Plus, Pro, Business) give monthly credits that expire at the end of
the period. Credit packs top up and last longer. Every job is quoted, held,
captured on success and refunded on failure. An "extra credits" switch decides
whether packs can be spent. Payments go through Paddle. See
[`docs/BILLING_PLANS.md`](docs/BILLING_PLANS.md) and
[`docs/PADDLE_SETUP.md`](docs/PADDLE_SETUP.md). Unpriced units are refused, never guessed.

## Non-negotiables

Standing brief: [`CLAUDE.md`](CLAUDE.md). The short version:

1. Never log, print, or commit a secret, or any part of one.
2. Do not loosen publishing, privacy, or the publish gate. Uploads are private
   by default and auto publish is a per-channel switch that is off.
3. Nothing in a browser may publish, re-render, or spend without the server deciding.
4. No silent quality fallback (wrong voice, no video).
5. Unknown is not a number. Unmeasured is not zero.
6. Fail early, and name the fix.
7. A channel is an account only once YouTube says so.
8. Diagnose before you fix.

## How it runs

- **Web:** the Command Center is built as a Docker image and runs on our own
  server behind Caddy. A push to `main` that touches the app, `deploy/` or the worker image deploys it through
  `.github/workflows/deploy_web.yml` and `deploy/remote-deploy.sh`
  ([`docs/DEPLOY_AX42.md`](docs/DEPLOY_AX42.md)). Environment variables are listed in
  `deploy/.env.web.example`.
- **Database and auth:** Supabase (Postgres with RLS). A migration is applied to the live
  database the moment it merges to `main` (Supabase GitHub integration), so it is
  dry-run on the live schema first, and a merged one is never edited: fix it with a
  new forward migration ([`docs/MIGRATIONS.md`](docs/MIGRATIONS.md)). Each file says what
  it needs and ends with a Verify query.
- **Videos:** two backends, chosen by `NIGHTSHIFT_RUN_BACKEND`. `actions` (default)
  dispatches `daily_video.yml` on GitHub Actions. `queue` writes a `render_jobs`
  row that a worker (`tools/queue_worker.py`, `Dockerfile.worker`) claims
  ([`docs/WORKER_VPS.md`](docs/WORKER_VPS.md)).
- **Small services** next to the web app, each behind its own switch in the same deploy:
  the pipeline worker, the creative worker, the customer Telegram sender (`notify-worker`,
  [`docs/NOTIFY_TELEGRAM_SETUP.md`](docs/NOTIFY_TELEGRAM_SETUP.md)), the customer e-mail
  sender (`email-worker`) and the operator bot.
- **Other workflows:** intelligence poll, provider balances, pending approvals,
  Telegram control, operator alerts, model probes, and the CI workflows (`tests`,
  `frontend`, `security`, `video-engine`).
- **Operator bot** (`@NightshiftAiStudio_bot`): the owner's read-only control panel in
  Telegram. Commands and inline buttons for `/health`, `/queue`, `/errors`,
  `/balance`, `/payments`, `/spend`, `/today`, `/users`, `/deploys`, `/approvals`,
  `/status`, `/pending`, `/security`, `/digest`, and `/marketing` (counts only; an
  information-only alert when a post waits for approval or was sent, never an approve button);
  de-duplicated, rate-limited proactive alerts with quiet hours and a daily digest;
  replies in seconds (long polling, or an optional webhook). It cannot publish,
  spend, approve, change prices or grant roles. Commands, alerts and the exact
  go-live steps: [`docs/operator-bot.md`](docs/operator-bot.md).

## Security

Every finding lives in [`docs/security/LEDGER.md`](docs/security/LEDGER.md) with
its fix and the test that fails if it comes back. `tests/security` runs against a
real Postgres. Process and rubric: [`docs/security/README.md`](docs/security/README.md).
Content-Security-Policy ships report-only: [`docs/security/CSP.md`](docs/security/CSP.md). The sign-in code step and the admin second-factor gate: [`docs/security/ADMIN_MFA.md`](docs/security/ADMIN_MFA.md).

Owner protection, in layers:

- **Second factor:** the owner pages need a fresh authenticator code
  (`NIGHTSHIFT_ADMIN_MFA=enforce`); a stolen password alone is not enough.
- **Server-side owner actions** (migration 0107, shipped dormant): credit grants with a
  per-call and a 24 h cap, a reason and an undo; price changes with history and a
  confirm step for big moves; roster changes that can never remove the last owner.
  Each is audited in the same transaction. The database half of the second factor is a
  switch that stays off until the owner has enrolled two authenticators and checked it
  with a real token.
- **Security trail:** an append-only `security_events` table that even the owner role
  cannot rewrite; the operator bot reads it.
- **Payments:** the Paddle webhook verifies the signature on a size-capped body, and
  refuses an API top-up whose currency, tax or total does not match what was ordered.

## Quick start (local)

```bash
python3 -m venv .venv && source .venv/bin/activate     # Python 3.11
pip install -r requirements.txt
cp .env.example .env          # fill the keys the pipeline needs
cp channels.example.json channels.json   # or manage channels in the Command Center

# ffmpeg + ImageMagick on PATH
python tools/setup_check.py
python main.py --no-upload --channel default
```

Command Center:

```bash
cd command-center
cp .env.example .env.local    # Supabase URL + anon key only
npm ci && npm run dev
```

## Verify a change

```bash
python3 -m unittest discover -s tests
cd command-center && npx tsc --noEmit && npx next lint && npx vitest run && npx next build
```

`test_compositor_readers` and `test_compositor_subtitles` need `moviepy`
installed. Every user-visible string lives in all three of
`command-center/lib/i18n/{en,ru,uz}.ts`.

CI's "Dependency advisories" step is `command-center/scripts/audit-gate.mjs`: production
dependencies fail it at moderate, dev ones at high, except advisories dated in
`command-center/scripts/audit-allowlist.mjs` (today: braces, which has no patched release
and is only reached by the linter). Read which step fails before treating a red job as real.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/INTELLIGENCE.md`](docs/INTELLIGENCE.md): the pipeline and the intelligence loop (written early; the code is the source of truth)
- [`docs/MEASUREMENT.md`](docs/MEASUREMENT.md): cost ledger, A/B, retention, the publish gate
- [`docs/MULTI_CHANNEL.md`](docs/MULTI_CHANNEL.md): per-channel tokens, schedule, registry
- [`docs/AUTONOMY.md`](docs/AUTONOMY.md): what is automatic and what is not
- [`docs/SUPABASE.md`](docs/SUPABASE.md), [`docs/SIGNUP_SETUP.md`](docs/SIGNUP_SETUP.md): schema, RLS, sign-up settings (Confirm email must be on)
- [`docs/API.md`](docs/API.md), [`docs/MCP.md`](docs/MCP.md), [`docs/CLI.md`](docs/CLI.md), [`skills/README.md`](skills/README.md): the ways in
- [`docs/BILLING_PLANS.md`](docs/BILLING_PLANS.md), [`docs/PADDLE_SETUP.md`](docs/PADDLE_SETUP.md): plans, credits, payments
- [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md): the migration process rule and dormant migrations
- [`docs/operator-bot.md`](docs/operator-bot.md), [`docs/NOTIFY_TELEGRAM_SETUP.md`](docs/NOTIFY_TELEGRAM_SETUP.md): the owner's bot and the customer notifications
- [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md), [`docs/CONNECT_ACCOUNTS.md`](docs/CONNECT_ACCOUNTS.md): going live, connecting YouTube, Instagram and TikTok
- [`docs/DEPLOY_AX42.md`](docs/DEPLOY_AX42.md), [`docs/WORKER_VPS.md`](docs/WORKER_VPS.md), [`docs/SELF_HOSTED_RUNNER.md`](docs/SELF_HOSTED_RUNNER.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): running it (several guides are in Uzbek)
- [`docs/ROADMAP_SAAS.md`](docs/ROADMAP_SAAS.md), [`docs/ROADMAP_VIDEO_OS.md`](docs/ROADMAP_VIDEO_OS.md): where it is going
- [`docs/design/`](docs/design): identity, type, motion, brand logos, design records
- [`docs/security/`](docs/security): ledger, process, CSP

## License

No license file yet. All rights reserved by the owner until one is added.
