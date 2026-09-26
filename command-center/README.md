# Nightshift Command Center

Real-time monitoring & control plane for the Nightshift content-automation bot.
Next.js (App Router) on Vercel, reading a Supabase Postgres project the bot
mirrors its state into. **Real data only** — anything the backend hasn't
produced shows `N/A` or `NOT CONFIGURED`, never invented numbers.

This app lives in the `command-center/` subdirectory of the `chronos_youtube_bot`
repo and deploys to its **own** Vercel project (set the Root Directory to
`command-center`). It is self-contained and can be moved to a dedicated repo at
any time.

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

Set these in `.env.local` (dev) and in the Vercel project (prod):

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

The production target is our own server: `command-center/Dockerfile` builds a
standalone image, `deploy/` runs it behind Caddy. Step by step (Uzbek):
`../docs/DEPLOY_AX42.md`. The Vercel path below still works unchanged and is
the rollback.

## Deploy to Vercel (its own project + subdomain)

1. In Vercel, **New Project** → import the `chronos_youtube_bot` repo.
2. Set **Root Directory** to `command-center`. Framework preset: Next.js.
3. Add the two `NEXT_PUBLIC_SUPABASE_*` environment variables.
4. Deploy.
5. **Domain:** in the Vercel project → **Settings → Domains**, add
   `monitor.<your-domain>` (or any subdomain). Vercel shows the exact DNS
   record to create — typically a `CNAME` for `monitor` pointing at
   `cname.vercel-dns.com`. Add that record at your DNS provider. **No DNS is
   changed automatically — you add the record yourself.**

## Security

- Login required (Supabase Auth). Middleware redirects unauthenticated visitors
  to `/login` — except on the three public pages Google's OAuth verification
  requires: the landing page `/`, `/privacy` and `/terms` (exact paths only;
  see `lib/public-paths.ts`).
- Row Level Security is enabled on every table with no public policy, so the
  anon key alone reads nothing — a signed-in user is required.
- The service-role key never appears in this app; only the bot (server-side, in
  GitHub Actions secrets) holds it.

## Vercel deployment notes

This app deploys as its **own** Vercel project, separate from the Python bot in
the repo root. When creating the project, two settings are essential:

- **Framework Preset:** `Next.js` (Vercel will otherwise auto-detect the Python
  bot at the repo root and try to build `main.py` — set this explicitly).
- **Root Directory:** `command-center` (so Vercel builds only this folder).

Set both, plus the two `NEXT_PUBLIC_SUPABASE_*` env vars, then deploy.
