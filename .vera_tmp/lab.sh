#!/bin/bash
# Runs the given lab files one at a time and prints each summary line.
service postgresql start >/dev/null 2>&1
cd /mnt/d/vera/wt/google-geo-and-size-pricing-v2 || exit 1
export NIGHTSHIFT_SECURITY_PG=postgresql://postgres:postgres@localhost:5432/postgres
for f in "$@"; do
  echo "== $f"
  /opt/vera-py/bin/python -m pytest "tests/security/$f.py" -p no:cacheprovider -q 2>&1 | grep -E 'FAILED|ERROR|passed|failed|error' | head -12
done
