"""Shell orchestration only; these mocks cannot establish SQL compatibility."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from ownership_report import COMPATIBILITY_CHECKS


class PolicyHarnessTests(unittest.TestCase):
    def test_subset_restore_and_secret_exclusion_on_success_and_failure(self):
        source = Path(__file__).resolve().parent
        probe = {'current_user':'postgres','session_user':'postgres',
                 'policy_created':True,'sqlstate':None,'policy_absent':True,
                 'supautils_registered':True}
        compatibility = {'current_user':'postgres','session_user':'postgres','superuser':False,
                         'read_only':True,'checks':dict.fromkeys(COMPATIBILITY_CHECKS,True),
                         'review_links':{'operation_helper':True,'policy_present':True},
                         'migration_versions':['0000','0001','0004']}
        for mode, startup_code in [('policy_repro',0),('policy_repro',1),('full_chain',0),('full_chain',1)]:
            with self.subTest(mode=mode,startup_code=startup_code), tempfile.TemporaryDirectory() as temp:
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
    if {mode!r} == 'policy_repro':
        assert sorted(x.name for x in p.iterdir()) == ['0000_base_schema.sql']
        assert p.joinpath('0000_base_schema.sql').read_text().count('X6_POLICY_PROBE') == 2
    else:
        assert {{f.name:f.read_bytes() for f in p.iterdir()}} == {original!r}
    for f in sorted(p.iterdir()): print('Applying migration '+f.name)
    print('raw sentinel-secret must never be published')
    if {startup_code} == 0 and {mode!r} == 'policy_repro':
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
    sql = sys.stdin.read()
    if {mode!r} == 'policy_repro':
        assert 'X6_POLICY_PROBE' in sql
        print('X6_POLICY_PROBE '+json.dumps({probe!r}))
    else:
        assert 'begin read only;' in sql and 'X6_COMPATIBILITY' in sql
        print('X6_COMPATIBILITY '+json.dumps({compatibility!r}))
''')
                for executable in fakebin.iterdir(): executable.chmod(0o755)
                evidence = root/'evidence'
                evidence.mkdir()
                (evidence/'report.json').write_text('{"stale":"sentinel-secret"}')
                (evidence/'fresh.raw').write_text('X6_COMPATIBILITY '+json.dumps(compatibility))
                (evidence/'fresh.exit').write_text('0')
                env = {'PATH':str(fakebin)+os.pathsep+os.environ['PATH'],
                       'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted',
                       'NIGHTSHIFT_TEST_MODE':mode}
                result = subprocess.run(['bash','tests/postgres/diagnose_storage_ownership.sh','evidence'],
                                        cwd=root,env=env,capture_output=True,text=True,timeout=30)
                self.assertEqual(result.returncode, startup_code, result.stderr)
                self.assertEqual({p.name:p.read_bytes() for p in migrations.iterdir()}, original)
                report_text = (root/'evidence/report.json').read_text()
                self.assertNotIn('sentinel-secret',report_text+result.stdout+result.stderr)
                report = json.loads(report_text)
                if mode == 'policy_repro':
                    self.assertEqual(report['full_chain'],'UNRUN')
                    self.assertEqual(report['reproduction'],'REPRODUCED' if startup_code == 0 else 'UNRUN')
                else:
                    self.assertEqual(report['full_chain'],'PASS' if startup_code == 0 else 'FAIL')
                    self.assertEqual(report['runtime_compatibility'],'PASS' if startup_code == 0 else 'UNRUN')


if __name__ == '__main__': unittest.main()
