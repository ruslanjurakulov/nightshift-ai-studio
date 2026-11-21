#!/usr/bin/env bash
set -euo pipefail
project="${NIGHTSHIFT_TEST_PROJECT:-nightshift-phase2b1f}"
compose=(docker compose -p "$project" -f tests/postgres/docker-compose.yml)
ids=$("${compose[@]}" ps -q 2>/dev/null || true)
if [[ -n "$ids" ]]; then
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    label=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$id")
    if [[ "$label" != "$project" ]]; then
      echo "refusing cleanup: unexpected compose project label" >&2
      exit 1
    fi
  done <<< "$ids"
fi
"${compose[@]}" down -v --remove-orphans

