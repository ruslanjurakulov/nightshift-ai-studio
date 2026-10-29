#!/usr/bin/env bash
set -euo pipefail

project="${NIGHTSHIFT_TEST_PROJECT:-nightshift-phase2b1f}"
compose=(docker compose -p "$project" -f tests/postgres/docker-compose.yml)
mapfile -t migrations < <(find supabase/migrations -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort -V)
if (( ${#migrations[@]} == 0 )); then
  echo 'No migrations found' >&2
  exit 1
fi

for name in "${migrations[@]}"; do
  echo "Applying local migration ${name}"
  if ! "${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 \
      -U nightshift_test -d nightshift_test < "supabase/migrations/${name}"; then
    echo "FIRST_MIGRATION_FAILURE=${name}" >&2
    exit 1
  fi
done

"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U nightshift_test -d nightshift_test < tests/postgres/fixtures.sql

