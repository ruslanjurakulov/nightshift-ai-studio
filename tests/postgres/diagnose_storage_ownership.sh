#!/usr/bin/env bash
set -euo pipefail
umask 077
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
keep = {'0000_base_schema.sql','0001_multi_channel.sql','0002_measurement.sql','0003_shorts.sql'}
p = Path('supabase/migrations')
assert all((p/name).is_file() for name in keep)
for f in p.glob('*.sql'):
    if f.name not in keep: f.unlink()
# Instrument only the ephemeral copy: evidence comes from the migration's
# actual session before services/startup can fail and remove the database.
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
python3 tests/postgres/ownership_report.py "$out_dir" "$rc"
# Reporting must not turn failed startup or absent SQL evidence into success.
[[ "$rc" == 0 ]]
python3 - "$out_dir/report.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['ownership_sql'] == 'PASS'
PY
