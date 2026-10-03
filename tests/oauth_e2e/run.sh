#!/usr/bin/env bash
# The whole rig for the end-to-end proof of MCP over OAuth (migration 0093):
#   1. a scratch Postgres database built from the repository's migrations (seed.py),
#   2. a Supabase-shaped HTTP shim in front of it (shim.py),
#   3. the real Command Center (next dev),
#   4. the OFFICIAL MCP SDK client doing discovery -> registration -> consent -> token
#      -> tools -> refresh -> revoke (command-center/scripts/oauth-e2e.mjs).
# Needs a Postgres superuser DSN in NIGHTSHIFT_SECURITY_PG (see docs/MCP.md) and
# python with psycopg. TEST-ONLY: nothing here talks to a real Supabase project.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
PY="${PYTHON:-python3}"; SHIM_PORT="${SHIM_PORT:-54999}"; APP_PORT="${APP_PORT:-3100}"
: "${NIGHTSHIFT_SECURITY_PG:?set NIGHTSHIFT_SECURITY_PG to a postgres superuser DSN}"
seed="$("$PY" "$here/seed.py")"
field() { printf '%s' "$seed" | "$PY" -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
dsn="$(field dsn)"
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
"$PY" "$here/shim.py" --dsn "$dsn" --port "$SHIM_PORT" >/dev/null & pids+=($!)
( cd "$root/command-center" && \
  NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:$SHIM_PORT" NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-e2e \
  APP_ORIGIN="http://localhost:$APP_PORT" NIGHTSHIFT_RUN_BACKEND=queue NEXT_TELEMETRY_DISABLED=1 \
  npx next dev -p "$APP_PORT" >/dev/null 2>&1 ) & pids+=($!)
for _ in $(seq 1 60); do curl -sf "http://localhost:$APP_PORT/.well-known/oauth-authorization-server" >/dev/null && break; sleep 1; done
( cd "$root/command-center" && BASE="http://localhost:$APP_PORT" \
  COOKIE="sb-127-auth-token=$(field cookie)" FREE_COOKIE="sb-127-auth-token=$(field free_cookie)" \
  node scripts/oauth-e2e.mjs )
