"""Export only schema-validated diagnostics, never raw Docker/CLI output."""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys


def category(raw, code, oom=False):
    # CLI retries can recover pull failures; the terminal exit is authoritative.
    if code == 0: return 'startup_success'
    if code == 124: return 'startup_timeout'
    if 'no space left on device' in raw.lower(): return 'disk_exhaustion'
    if oom or re.search(r'out of memory|oomkill', raw, re.I): return 'memory_exhaustion'
    if re.search(r'SQLSTATE|ERROR:.*(?:relation|policy|permission)', raw): return 'migration_failure'
    if re.search(r'unhealthy|health check.*fail', raw, re.I): return 'container_health_failure'
    if re.search(r'failed to (?:pull|resolve|copy)|pull access denied|manifest unknown|toomanyrequests|error pulling', raw, re.I): return 'image_pull_failure'
    return 'startup_success' if code == 0 else 'unknown_startup_failure'


def pull_evidence(raw):
    # Export only public image references, never arbitrary error text/URLs.
    images = sorted(set(re.findall(
        r"(?:ghcr\.io|public\.ecr\.aws)/supabase/[a-z0-9-]+:[A-Za-z0-9._-]+", raw)))
    reason = ('rate_limited' if re.search(r'toomanyrequests|too many requests', raw, re.I)
              else 'not_established')
    return {'public_images_mentioned': images, 'pull_reason': reason}


def safe_evidence(raw):
    matches = re.findall(r'X6_EVIDENCE (\{[^\n]+\})', raw)
    if not matches: return None
    obj = json.loads(matches[-1])
    # Do not publish unrecognized fields or arbitrary messages/values.
    required = {'current_user','session_user','superuser','tables','memberships'}
    assert set(obj) in (required, required | {'supautils'})
    if 'supautils' in obj:
        extension = obj['supautils']
        assert set(extension) == {'version','session_preloaded','shared_preloaded','objects_policy_grant','buckets_policy_grant'}
        assert extension['version'] is None or (isinstance(extension['version'], str) and re.fullmatch(r'[0-9][0-9A-Za-z.+-]{0,39}',extension['version']))
        for key in ('session_preloaded','shared_preloaded'):
            assert type(extension[key]) is bool
        for key in ('objects_policy_grant','buckets_policy_grant'):
            assert extension[key] is None or type(extension[key]) is bool
    name = lambda v: isinstance(v,str) and re.fullmatch(r'[a-z_][a-z_0-9]{0,62}',v)
    assert name(obj['current_user']) and name(obj['session_user'])
    assert type(obj['superuser']) is bool
    assert {t['table'] for t in obj['tables']} == {'objects','buckets'}
    for t in obj['tables']:
        assert set(t) == {'table','owner','owner_usage','owner_member'}
        assert name(t['owner']) and all(type(t[k]) is bool for k in ('owner_usage','owner_member'))
    for m in obj['memberships'] or []:
        assert set(m) == {'member','granted','inherit'}
        assert name(m['member']) and name(m['granted']) and type(m['inherit']) is bool
    return obj


def main(directory, code):
    out = pathlib.Path(directory)
    raw = (out/'start.raw').read_text(errors='replace')
    evidence = safe_evidence(raw)  # Validation errors stop publication entirely.
    def docker(*args):
        p = subprocess.run(['docker',*args],capture_output=True,text=True,timeout=15)
        return p.stdout if p.returncode == 0 else ''
    ids = docker('ps','-aq','--filter','label=com.supabase.cli.project=nightshift-phase2b1f').split()
    states = []
    for cid in ids:
        if not re.fullmatch('[a-f0-9]{12,64}',cid): continue
        text = docker('inspect','--format','{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',cid).strip()
        if re.fullmatch(r'(created|running|paused|restarting|removing|exited|dead) -?\d+ (true|false) (none|starting|healthy|unhealthy)',text):
            states.append(text)
    registry = os.environ.get('SUPABASE_INTERNAL_IMAGE_REGISTRY', '')
    assert registry in ('', 'ghcr.io', 'public.ecr.aws', 'docker.io')
    report = {'registry':registry, **pull_evidence(raw), 'scope':'diagnostic_subset_0000_0003','full_chain':'UNRUN',
              'startup_exit_code':code,'failure_category':category(raw,code,any(' true ' in s for s in states)),
              'ownership_sql':'PASS' if evidence else 'UNRUN','migration_session':evidence,
              'disk_free_bytes':shutil.disk_usage('.').free,'container_states':states,
              'container_snapshot':'available' if states else 'unavailable_or_removed_by_cli',
              'image_count':len(docker('images','-q').splitlines())}
    mem = pathlib.Path('/proc/meminfo').read_text()
    report['mem_available_kib'] = int(re.search(r'MemAvailable:\s+(\d+)',mem)[1])
    sqlstates = re.findall(r'SQLSTATE ([0-9A-Z]{5})',raw)
    report['sqlstate'] = sqlstates[-1] if sqlstates else None
    files = re.findall(r'Applying migration ([0-9]+_[A-Za-z0-9_-]+\.sql)',raw)
    report['last_migration_started'] = files[-1] if files else None
    (out/'report.json').write_text(json.dumps(report,indent=2)+'\n')


if __name__ == '__main__': main(sys.argv[1], int(sys.argv[2]))
