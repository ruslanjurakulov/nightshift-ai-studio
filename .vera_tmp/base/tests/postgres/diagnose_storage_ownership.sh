#!/usr/bin/env bash
set -euo pipefail

# This is an evidence-only path. It deliberately starts the local stack with
# the first migrations only; it never changes a Storage table owner or grants
# privileges. The original migration directory is restored on every exit.
out_dir="${1:?output directory required}"
mkdir -p "$out_dir"
backup_dir="$(mktemp -d)"
restored=false

restore_migrations() {
  if [[ "$restored" == true ]]; then return; fi
  rm -f supabase/migrations/*.sql
  cp "$backup_dir"/*.sql supabase/migrations/
  restored=true
}
trap restore_migrations EXIT INT TERM

cp supabase/migrations/*.sql "$backup_dir"/
find supabase/migrations -maxdepth 1 -type f -name '*.sql' ! \
  \( -name '0000_base_schema.sql' -o -name '0001_multi_channel.sql' \
     -o -name '0002_measurement.sql' -o -name '0003_shorts.sql' \) -delete

if ! supabase start >"$out_dir/supabase-start.log" 2>&1; then
  echo 'DIAGNOSTIC_START=FAIL' >"$out_dir/ownership.log"
  exit 1
fi

psql "host=127.0.0.1 port=55322 dbname=postgres user=postgres" \
  -X -v ON_ERROR_STOP=1 -Atf tests/postgres/storage_ownership.sql \
  >"$out_dir/ownership.log" 2>&1

echo 'DIAGNOSTIC_START=PASS' >>"$out_dir/ownership.log"
supabase stop >"$out_dir/supabase-stop.log" 2>&1 || true
restore_migrations
