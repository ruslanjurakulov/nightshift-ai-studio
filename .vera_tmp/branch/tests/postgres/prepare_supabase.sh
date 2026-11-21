#!/usr/bin/env bash
set -euo pipefail

test ! -e supabase/config.toml || { echo 'refusing to overwrite supabase/config.toml' >&2; exit 1; }
test ! -e supabase/migrations/0000_base_schema.sql || { echo 'refusing existing ephemeral base migration' >&2; exit 1; }
cp tests/postgres/config.toml supabase/config.toml
cp supabase/schema.sql supabase/migrations/0000_base_schema.sql
echo 'Prepared ephemeral Supabase config and 0000 base migration'

