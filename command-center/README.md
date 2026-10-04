# Nightshift Command Center

The Nightshift web app and public site: monitoring and control for the
content-automation bot, plus sign-up, credits, the public API and the MCP page.
Next.js (App Router), self-hosted in Docker, reading a Supabase Postgres project
the bot mirrors its state into. **Real data only** — anything the backend hasn't
produced shows `N/A` or `NOT CONFIGURED`, never invented numbers.

This app lives in the `command-center/` subdirectory of the `nightshift-ai-studio`
repo and is deployed by `.github/workflows/deploy_web.yml` (see Self-hosting
below). It is self-contained and can be moved to a dedicated repo at any time.

## What it shows

- **Command Center** (`/`) — system health, published-today, active agents,
  errors, DB health, a realtime Live Activity Feed (Supabase Realtime), top
  learned topic scores, and recent videos.
- Further pages — Videos, Pipeline, Agents, Jobs, Topics, Analytics, Feedback
  Loop, Errors, Logs, Integrations — read the same Supabase tables.

## Prerequisites

1. A Supabase project with the schema applied — see `../docs/SUPABASE.md` and
   `../supabase/schema.sql`.
2. The bot configured to mirror state (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`
   set as GitHub Actions secrets — same doc).
3. At least one Supabase **user** created (Authentication → Users) — the panel
   is login-gated and RLS makes data readable only to authenticated users.

## Environment

Set these in `.env.local` (dev). In production they are GitHub Actions variables
and secrets that `deploy_web.yml` passes to the server (full list:
`../deploy/.env.web.example`):

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

Only the **anon** key — never the service key — belongs in this app.

The public Privacy Policy and Terms of Service (`/privacy`, `/terms`) print the
operator's details from four more public variables. None has a default: until
each is set, the pages show a visible **NOT CONFIGURED** marker in its place.

| Variable | What it is |
| :-- | :-- |
| `NEXT_PUBLIC_LEGAL_NAME` | Legal name of the operator (person or company) |
| `NEXT_PUBLIC_CONTACT_EMAIL` | Privacy / support contact address |
| `NEXT_PUBLIC_LEGAL_COUNTRY` | Country whose law governs the Terms |
| `NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE` | `YYYY-MM-DD` the current texts took effect |

They are read in `lib/legal.ts`. The owner's checklist for Google's OAuth
verification is in `docs/GOOGLE_OAUTH_VERIFICATION.md`.

The public Pricing page (`/pricing`) shows the three credit packs. When Paddle
is configured (`NEXT_PUBLIC_PADDLE_*`, see `docs/PADDLE_SETUP.md`) it asks
Paddle for each pack's localized price; otherwise, or as the fallback, it
prints these public variables as written. With neither, the page says pricing
is coming soon — no price is ever defaulted (`lib/pricing.ts`).

| Variable | What it is |
| :-- | :-- |
| `NEXT_PUBLIC_PRICE_DISPLAY_STARTER` / `_CREATOR` / `_STUDIO` | Display price per pack, e.g. `$10` |
| `NEXT_PUBLIC_CREDITS_EXPIRY_MONTHS` | Months until unused credits expire; empty = they do not expire (what the system does) |

## Local development

```bash
cd command-center
npm install
cp .env.example .env.local   # fill in the two values
npm run dev                  # http://localhost:3000
```

`npm run typecheck` and `npm run lint` check types and style; `npm run build`
produces the production build.

## Self-hosting (Docker + Caddy)

Production is our own server: `command-center/Dockerfile` builds a standalone
image and `deploy/` runs it behind Caddy. A push to `main` that touches the app
or `deploy/` deploys it through `.github/workflows/deploy_web.yml`. Step by step
(Uzbek): `../docs/DEPLOY_AX42.md`.

Production no longer runs on Vercel (its Hobby plan forbids commercial use). The
app can still run there if ever needed: create a project from this repo, set the
**Root Directory** to `command-center` and the **Framework Preset** to `Next.js`
(otherwise Vercel detects the Python bot at the repo root), and add the
environment variables. Features that need the server's disk (the media library)
report "not available on this host" there.

## Security

- Login required (Supabase Auth). Middleware redirects unauthenticated visitors
  to `/login` — except on the exact public paths listed in
  `lib/public-paths.ts` (the landing page, pricing, docs, `/mcp`, sign-in and the
  legal pages Google's OAuth verification requires).
- Row Level Security is enabled on every table with no public policy, so the
  anon key alone reads nothing — a signed-in user is required.
- The service-role key never appears in this app; only the bot (server-side, in
  GitHub Actions secrets) holds it.
