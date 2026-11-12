# Nightshift

Nightshift is a web studio for making images, video, voice and music with several generative models,
editing video in the browser, and publishing. Automated YouTube channel production, the project's
original purpose, is one path inside it.

Live site: <https://nightshift-ai.studio>. Accounts are for people aged 18 or older.

How the parts fit together: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The code is the source of
truth, and where this page and the code disagree, the code is right.

## What it does

| Area | What it is | Where |
| :-- | :-- | :-- |
| Generate | Images, video, speech, sound effects and music. Models are integrated through each maker's own API. A model is offered only after a real probe call through its adapter has succeeded, its vendor terms are cleared and it has a credit price | `schemas/model_registry.json`, `modules/capabilities/`, migration 0035 |
| Edit | A browser video editor: timeline, trims, roll, slip and slide edits, speed and speed curves, colour, masks, overlays and shapes, captions, voice-over, effects and transitions, export in other frame shapes and higher resolutions. The edit is a document that TypeScript and Python validate on the same shared cases, and the server renders it with ffmpeg | `command-center/lib/editor.ts`, `modules/timeline.py`, [`docs/editor-render-fields.md`](docs/editor-render-fields.md) |
| Publish | YouTube upload of pipeline videos, private by default, behind the publish gate, with per-channel approval rules | `modules/publish_gate.py`, `modules/publish_approval.py` |
| Channel pipeline | Topic, research, script, fact-check, narration, media, captions, thumbnails, render, quality check, upload or hold, plus an analytics and comments loop that feeds the next topic | `main.py`, `modules/`, [`docs/INTELLIGENCE.md`](docs/INTELLIGENCE.md) |
| Other ways in | A public REST API (`/api/v1`, its own prepaid balance), an MCP server (`/api/mcp`) for AI assistants, and a CLI | [`docs/API.md`](docs/API.md), [`docs/MCP.md`](docs/MCP.md), [`docs/CLI.md`](docs/CLI.md) |

## What works today and what is dark

Many features are merged but switched off. A feature is off until its switch is set. The switches are
GitHub repository variables, read at deploy time (`.github/workflows/deploy_web.yml`). Their values on
the live site are not recorded in this repository, so this page does not claim which ones are on.

| Status in code | Features |
| :-- | :-- |
| No feature switch in the web app | Sign-up and sign-in, organizations and roles, credits and plans, the studio's generation flow for models that pass the database checks, the editor and exports up to 1080p, the media library, the publish gate. Generations, uploads and exports are carried out only while their workers are deployed (`NIGHTSHIFT_CREATIVE_WORKER`, `NIGHTSHIFT_WORKER`) |
| Off until a web or worker switch is on | Multi-ratio export (`NIGHTSHIFT_MULTI_RATIO_EXPORT`), 1440p and 4K export (`NIGHTSHIFT_HIRES_EXPORT`), the image editor, the region editor, Character Studio, Ads Factory and brand scan, the results dashboard, Series Factory, custom voice, agent drafts, MCP sign-in (`MCP_OAUTH_LIVE`), the CLI page (`DEV_CLI_PAGE`), publish when approved (`PUBLISH_ON_APPROVE_RELEASED` and the worker's `NIGHTSHIFT_VISIBILITY_PUBLISH`), the owner's server-side actions (`NIGHTSHIFT_OWNER_RPC`) |
| Off until the owner sets a price in the database | 1440p and 4K export, and paid export up to 1080p (migrations 0132, 0136; NULL means not on sale or no charge) |
| Off by default in the pipeline | AI b-roll and AI images (stock media otherwise), the presenter avatar, the Remotion scene renderer, agent autopilot topic choice |
| Not shipped | The CLI is not on npm. The repository has no licence (see below), and the package refuses to publish until one is set |

## Money

Plans give monthly credits, and credit packs top up. Payments go through Paddle. Every paid job is
quoted by the server, held, then captured on success or released on failure, in the database
(migrations 0020, 0036). An unpriced unit is refused, never charged at a guessed rate. See
[`docs/BILLING_PLANS.md`](docs/BILLING_PLANS.md) and [`docs/PADDLE_SETUP.md`](docs/PADDLE_SETUP.md).

## Stack

| Part | Technology |
| :-- | :-- |
| Web app ("Command Center") | Next.js App Router, TypeScript, in `command-center/` |
| Database and auth | Supabase Postgres with Row Level Security; writes that matter go through `security definer` SQL functions |
| Workers | Python 3.11 services in one Docker image (`Dockerfile.worker`): pipeline queue, creative jobs, media and editor exports, notifications, e-mail, operator bot, marketing, brand scan |
| Rendering | ffmpeg (editor exports and the declarative pipeline path), MoviePy (pipeline default), optional Remotion (`video-engine/`) |
| Hosting | Docker Compose behind Caddy on a dedicated server; GitHub Actions for the pipeline schedule, probes, alerts and CI |
| Payments | Paddle, webhook as a Supabase Edge Function |

## Repository layout

```
command-center/          Next.js app: public site, signed-in app (/{channel}/...), API routes
modules/                 Python: pipeline stages, model adapters (modules/capabilities/), workers' logic
main.py                  the pipeline, one run for one channel
tools/                   worker entry points and scripts the workflows call
schemas/                 model registry and the timeline document schema
supabase/migrations/     Postgres schema, RLS and SQL functions; additive, applied on merge
supabase/functions/      Edge Functions (Paddle webhook, Telegram webhook)
docs/sql/                owner-run scripts: one-time clean-ups and rollbacks, never migrations
packages/cli/            @nightshift/cli, a command-line client for the public API (not published)
skills/                  Agent Skills that teach an AI agent to use the CLI and MCP
video-engine/            Remotion scene renderer (off by default)
deploy/                  Docker Compose, Caddy, the deploy script and the env examples
tests/                   Python tests; tests/security is the security lab (real Postgres)
docs/                    design records, guides, the security ledger
```

## Run the tests

```bash
python3 -m venv .venv && source .venv/bin/activate     # Python 3.11
pip install -c constraints.txt -r requirements.txt
python3 -m unittest discover tests                      # what CI runs; pytest -q tests also works

cd command-center && npm ci
npx tsc --noEmit && npx next lint && npx vitest run && npx next build
```

`test_compositor_readers` and `test_compositor_subtitles` need `moviepy`. The security lab
(`tests/security`) needs a Postgres it may create databases in (`NIGHTSHIFT_SECURITY_PG`) and is skipped
without one. CI runs it in `.github/workflows/security.yml`. Every user-visible string lives in all three
of `command-center/lib/i18n/{en,ru,uz}.ts`.

To run the pipeline locally, copy `.env.example` to `.env` and `channels.example.json` to
`channels.json`, put ffmpeg and ImageMagick on `PATH`, run `python tools/setup_check.py`, then
`python main.py --no-upload --channel default`. For the web app, copy `command-center/.env.example` to
`.env.local` (Supabase URL and anon key only) and run `npm run dev`.

## Rules the code keeps

The standing brief for contributors is the brief file at the repository root. In short: never log or
commit a secret; uploads stay private unless a person decides otherwise, and the publish gate is never
loosened; nothing in a browser publishes, renders or spends without the server deciding; no silent
quality fallback; an unknown is never shown as a number; fail early and name the fix.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the system map
- [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md): the migration rule (never edit a merged migration)
- [`docs/security/LEDGER.md`](docs/security/LEDGER.md), [`docs/security/README.md`](docs/security/README.md): every security finding, its fix and its test; the process
- [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md): the standard for the public site, and the owner's open items
- [`docs/editor-render-fields.md`](docs/editor-render-fields.md): every field the editor's export understands
- [`docs/research/premiere-parity.md`](docs/research/premiere-parity.md): the editor parity plan
- [`docs/API.md`](docs/API.md), [`docs/MCP.md`](docs/MCP.md), [`docs/CLI.md`](docs/CLI.md), [`skills/README.md`](skills/README.md): the ways in
- [`docs/BILLING_PLANS.md`](docs/BILLING_PLANS.md), [`docs/PADDLE_SETUP.md`](docs/PADDLE_SETUP.md): plans, credits, payments
- [`docs/AI_DISCLOSURE.md`](docs/AI_DISCLOSURE.md): how AI-made media is labelled
- [`docs/DEPLOY_AX42.md`](docs/DEPLOY_AX42.md), [`docs/WORKER_VPS.md`](docs/WORKER_VPS.md): running it (partly in Uzbek)

## Ownership and licence

The code is proprietary. All rights are reserved by the owner unless the owner says otherwise. The
repository has no licence file, and being able to read it does not grant a licence.
