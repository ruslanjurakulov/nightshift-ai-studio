# syntax=docker/dockerfile:1
#
# The Command Center as a self-hosted container (see deploy/ and
# docs/DEPLOY_AX42.md). Build context is this directory:
#
#   docker build -f command-center/Dockerfile \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=... \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
#     command-center
#
# What goes where, and why:
#   * NEXT_PUBLIC_* are build args. Next inlines them into the browser bundle
#     at build time, so they are public by construction (the anon key is meant
#     to be public; RLS and login keep the data private). Changing one means a
#     rebuild, not a restart.
#   * Everything server-only (GITHUB_SECRETS_TOKEN, GOOGLE_OAUTH_CLIENT_SECRET,
#     ...) is NEVER a build arg: a build arg lands in the image history, and an
#     image gets pushed, cached and copied. Those arrive at runtime through the
#     env file (deploy/docker-compose.yml -> env_file).
#   * The Supabase service key belongs to the bot only. It is not an input here
#     in any form.

ARG NODE_IMAGE=node:22-bookworm-slim

# ── 1. Dependencies, from the lockfile exactly ───────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── 2. Build ─────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY} \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `public/` is optional in Next but the runner copies it unconditionally, so a
# missing one must not fail the COPY below.
RUN mkdir -p public && npx next build

# ── 3. Runtime: the traced standalone server, nothing else ───────────────────
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The base image ships an unprivileged `node` user (uid 1000). The app files
# stay root-owned and read-only to it; only the Next cache is writable, so a
# compromised request handler cannot rewrite the server it runs in.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
RUN mkdir -p .next/cache && chown node:node .next/cache

USER node
EXPOSE 3000

# /login is the one page that renders for an anonymous caller (every other path
# redirects there). Any answer below 500 means the server is up and routing;
# `fetch` is built into Node 22, so no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login',{redirect:'manual',signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
