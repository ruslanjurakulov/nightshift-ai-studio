#!/usr/bin/env bash
set -euo pipefail

if ! command -v supabase >/dev/null 2>&1; then
  echo "UNRUN: Supabase CLI is not installed" >&2
  exit 2
fi
if ! supabase status >/dev/null 2>&1; then
  echo "UNRUN: local Supabase stack is not running" >&2
  exit 2
fi

log=$(mktemp)
trap 'rm -f "$log"' EXIT
if ! supabase db reset --local 2>&1 | tee "$log"; then
  first=$(grep -Eo '[0-9]{4,}_[A-Za-z0-9_-]+\.sql' "$log" | head -1 || true)
  if [[ -n "$first" ]]; then
    echo "FIRST_MIGRATION_FAILURE=${first}" >&2
  else
    echo "FIRST_MIGRATION_FAILURE=UNIDENTIFIED_CLI_OUTPUT" >&2
  fi
  exit 1
fi
echo "Supabase local migration reset completed"

