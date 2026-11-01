#!/usr/bin/env bash
set -euo pipefail
umask 077
export NIGHTSHIFT_TEST_MODE="${NIGHTSHIFT_TEST_MODE:-ownership}"
[[ "$NIGHTSHIFT_TEST_MODE" == ownership || "$NIGHTSHIFT_TEST_MODE" == full_chain || "$NIGHTSHIFT_TEST_MODE" == policy_repro ]]
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
[[ "$(supabase --version 2>/dev/null)" == 2.67.1 ]]
cmp -s supabase/config.toml tests/postgres/config.toml
[[ ! -e supabase/.temp/project-ref ]]
for v in ${!PG@} SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD DATABASE_URL SUPABASE_URL SUPABASE_SERVICE_KEY; do
  [[ ! -v "$v" ]] || { echo 'BLOCKED: database environment override'; exit 2; }
done
out_dir="${1:?output directory required}"
mkdir -p "$out_dir"
# Move the entire directory only after a complete backup exists. EXIT restores
# the exact original files; a cancelled VM is disposable and never reused.
backup_dir="$(mktemp -d)"
cp -a supabase/migrations "$backup_dir/original"
restore_migrations() {
  python3 - "$backup_dir" <<'PY'
import pathlib, shutil, sys
backup = pathlib.Path(sys.argv[1]) / 'original'
if backup.is_dir():
    shutil.rmtree('supabase/migrations')
    shutil.copytree(backup, 'supabase/migrations')
    assert {p.name:p.read_bytes() for p in backup.iterdir() if p.is_file()} == {p.name:p.read_bytes() for p in pathlib.Path('supabase/migrations').iterdir() if p.is_file()}
    shutil.rmtree(backup.parent)
PY
}
trap restore_migrations EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - <<'PY'
from pathlib import Path
import os, json
files = sorted(f.name for f in Path('supabase/migrations').glob('*.sql'))
Path('migration-manifest.json').write_text(json.dumps(files))
if os.environ['NIGHTSHIFT_TEST_MODE'] == 'full_chain':
    raise SystemExit(0)
keep = {'0000_base_schema.sql','0001_multi_channel.sql','0002_measurement.sql','0003_shorts.sql'}
if os.environ['NIGHTSHIFT_TEST_MODE'] == 'policy_repro':
    keep = {'0000_base_schema.sql'}
p = Path('supabase/migrations')
assert all((p/name).is_file() for name in keep)
for f in p.glob('*.sql'):
    if f.name not in keep: f.unlink()
# Instrument only the ephemeral copy: evidence comes from the migration's
# actual session before services/startup can fail and remove the database.
if os.environ['NIGHTSHIFT_TEST_MODE'] == 'policy_repro':
    with (p/'0000_base_schema.sql').open('a') as f:
        for name in ('policy_probe.sql', 'publication_error_probe.sql', 'policy_probe.sql'):
            f.write('\n' + Path('tests/postgres', name).read_text())
else:
    with (p/'0003_shorts.sql').open('a') as f:
        f.write('\n' + Path('tests/postgres/storage_ownership.sql').read_text())
PY
exclude='studio,postgres-meta,logflare,vector,realtime,edge-runtime,mailpit,supavisor'
# CLI otherwise warns and ignores misspelled names. Validate against its help.
supabase start --help >"$out_dir/help.raw" 2>&1
python3 - "$out_dir/help.raw" "$exclude" <<'PY'
import pathlib,re,sys
help = pathlib.Path(sys.argv[1]).read_text()
line = next(x for x in help.splitlines() if '--exclude' in x)
names = re.search(r'\[([^]]+)\]',line).group(1).split(',')
assert set(sys.argv[2].split(',')) <= set(names)
PY
set +e
timeout --signal=TERM --kill-after=30s 900s supabase start --exclude "$exclude" >"$out_dir/start.raw" 2>&1
rc=$?
set -e
if [[ "$rc" == 0 && "$NIGHTSHIFT_TEST_MODE" == policy_repro ]]; then
  # A fresh postgres session tests whether the fault is backend-local. No TCP
  # endpoint, credentials, role changes or arbitrary container selection.
  db_container=supabase_db_nightshift-phase2b1f
  [[ "$(docker inspect --format '{{index .Config.Labels "com.supabase.cli.project"}}' "$db_container")" == nightshift-phase2b1f ]]
  set +e
  timeout 30s docker exec -i "$db_container" env -i PATH=/usr/local/bin:/usr/bin:/bin \
    psql -X --no-password -h /var/run/postgresql -U postgres -d postgres \
    --set ON_ERROR_STOP=1 < tests/postgres/policy_probe.sql >"$out_dir/fresh.raw" 2>&1
  fresh_rc=$?
  set -e
  printf '%s\n' "$fresh_rc" >"$out_dir/fresh.exit"
fi
python3 tests/postgres/ownership_report.py "$out_dir" "$rc"
# Reporting must not turn failed startup or absent SQL evidence into success.
[[ "$rc" == 0 ]]
python3 - "$out_dir/report.json" <<'PY'
import json,sys
import os
report = json.load(open(sys.argv[1]))
key = {'full_chain':'full_chain', 'ownership':'ownership_sql', 'policy_repro':'policy_repro'}[os.environ['NIGHTSHIFT_TEST_MODE']]
assert report[key] == 'PASS'
PY
