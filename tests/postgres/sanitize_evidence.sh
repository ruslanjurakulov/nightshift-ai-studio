#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:?output directory required}"
mkdir -p "$out_dir"
for input in migration-reset.log sql-smoke.log supabase-start.log; do
  [[ -f "$input" ]] || continue
  sed -E \
    -e 's#(postgres(ql)?://)[^[:space:]]+#\1[REDACTED-DSN]#g' \
    -e 's#(SUPABASE_URL|SUPABASE_SERVICE_KEY|DATABASE_URL|password|token|api[_ -]?key|secret)[=:][^[:space:]]+#\1=[REDACTED]#gi' \
    "$input" > "$out_dir/$input"
  if grep -Eiq '(SUPABASE_SERVICE_KEY|DATABASE_URL|postgres(ql)?://[^[:space:]]+|eyJ[A-Za-z0-9_-]+\.)' "$out_dir/$input"; then
    echo "refusing to publish unsanitized evidence: $input" >&2
    rm -rf "$out_dir"
    exit 1
  fi
done

test -d "$out_dir"

