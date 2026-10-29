#!/usr/bin/env bash
set -euo pipefail

if ! command -v supabase >/dev/null 2>&1; then
  echo "UNRUN: Supabase CLI is not installed" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "UNRUN: Docker CLI is not installed" >&2
  exit 2
fi
if ! supabase status >/tmp/nightshift-supabase-status.txt 2>/tmp/nightshift-supabase-status.err; then
  echo "UNRUN: local Supabase stack is not running" >&2
  exit 2
fi

project="${NIGHTSHIFT_TEST_PROJECT:-nightshift-phase2b1f}"
if [[ "$project" != nightshift-phase2b1f* ]]; then
  echo "UNRUN: refusing a non-test project name" >&2
  exit 2
fi

echo "Supabase local runtime is available for project ${project}"
echo "Required runtime objects are checked by the SQL runner, not assumed here"
