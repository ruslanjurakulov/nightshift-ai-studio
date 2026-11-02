"""Shell orchestration only; these mocks cannot establish SQL compatibility."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class PolicyHarnessTests(unittest.TestCase):
    def test_subset_restore_and_secret_exclusion_on_success_and_failure(self):
        source = Path(__file__).resolve().parent
        probe = {'current_user':'postgres','session_user':'postgres',
                 'policy_created':True,'sqlstate':None,'policy_absent':True,
                 'supautils_registered':True}
        for startup_code in (0, 1):
            with self.subTest(startup_code=startup_code), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                (root/'tests').mkdir()
                shutil.copytree(source, root/'tests/postgres', ignore=shutil.ignore_patterns('__pycache__'))
                migrations = root/'supabase/migrations'
                migrations.mkdir(parents=True)
                original = {'0000_base_schema.sql':b'-- synthetic base\n',
                            '0001_multi_channel.sql':b'-- original marker\n',
                            '0004_review.sql':b'-- never execute\n'}
                for name, data in original.items():
                    (migrations/name).write_bytes(data)
                shutil.copy(source/'config.toml',root/'supabase/config.toml')
                fakebin = root/'bin'
                fakebin.mkdir()
                body = f'''#!/usr/bin/env python3
import json, pathlib, sys
args = sys.argv[1:]
if args == ['--version']: print('2.122.0')
elif '--help' in args:
    print('--exclude [studio,postgres-meta,logflare,vector,realtime,edge-runtime,mailpit,supavisor]')
else:
    p = pathlib.Path('supabase/migrations')
    assert sorted(x.name for x in p.iterdir()) == ['0000_base_schema.sql']
    assert p.joinpath('0000_base_schema.sql').read_text().count('X6_POLICY_PROBE') == 2
    print('Applying migration 0000_base_schema.sql')
    print('raw sentinel-secret must never be published')
    if {startup_code} == 0:
        probe = {probe!r}
        print('X6_POLICY_PROBE '+json.dumps(probe))
        print('X6_DUPLICATE '+json.dumps({{'duplicate_seen':True}}))
        probe.update(policy_created=False, sqlstate='42501')
        print('X6_POLICY_PROBE '+json.dumps(probe))
    sys.exit({startup_code})
'''
                (fakebin/'supabase').write_text(body)
                (fakebin/'docker').write_text(f'''#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
if args[0] == 'inspect': print('nightshift-phase2b1f')
elif args[0] == 'exec':
    assert 'supabase_db_nightshift-phase2b1f' in args
    assert '/var/run/postgresql' in args and '--no-password' in args
    assert 'X6_POLICY_PROBE' in sys.stdin.read()
    print('X6_POLICY_PROBE '+json.dumps({probe!r}))
''')
                for executable in fakebin.iterdir(): executable.chmod(0o755)
                env = {'PATH':str(fakebin)+os.pathsep+os.environ['PATH'],
                       'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted',
                       'NIGHTSHIFT_TEST_MODE':'policy_repro'}
                result = subprocess.run(['bash','tests/postgres/diagnose_storage_ownership.sh','evidence'],
                                        cwd=root,env=env,capture_output=True,text=True,timeout=30)
                self.assertEqual(result.returncode, startup_code, result.stderr)
                self.assertEqual({p.name:p.read_bytes() for p in migrations.iterdir()}, original)
                report_text = (root/'evidence/report.json').read_text()
                self.assertNotIn('sentinel-secret',report_text+result.stdout+result.stderr)
                report = json.loads(report_text)
                self.assertEqual(report['full_chain'],'UNRUN')
                self.assertEqual(report['reproduction'],'REPRODUCED' if startup_code == 0 else 'UNRUN')


if __name__ == '__main__': unittest.main()
