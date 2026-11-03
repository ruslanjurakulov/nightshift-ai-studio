import unittest
from ownership_report import (category, safe_evidence, pull_evidence, chain_status,
                              policy_repro_evidence, compatibility_evidence, COMPATIBILITY_CHECKS)

class ReportTests(unittest.TestCase):
    def test_compatibility_requires_exact_history_prerequisites_and_readonly_identity(self):
        import copy
        import json
        expected = ['0000_base_schema.sql','0001_multi_channel.sql']
        good = {'current_user':'postgres','session_user':'postgres','superuser':False,
                'read_only':True,'checks':dict.fromkeys(COMPATIBILITY_CHECKS,True),
                'review_links':{'operation_helper':True,'policy_present':True},
                'migration_versions':['0000','0001']}
        encode = lambda obj: 'X6_COMPATIBILITY '+json.dumps(obj)
        result = compatibility_evidence(encode(good),0,expected)
        self.assertEqual(result['runtime_compatibility'],'PASS')
        self.assertEqual(result['migration_history'],'PASS')
        for field, value in [('superuser',True),('read_only',False),
                             ('migration_versions',['0000']),
                             ('migration_versions',['0000','0000']),
                             ('migration_versions',['0001','0000'])]:
            bad = dict(good, **{field:value})
            self.assertEqual(compatibility_evidence(encode(bad),0,expected)['runtime_compatibility'],'FAIL')
        for key in COMPATIBILITY_CHECKS:
            bad = copy.deepcopy(good)
            bad['checks'][key] = False
            self.assertEqual(compatibility_evidence(encode(bad),0,expected)['runtime_compatibility'],'FAIL')
        self.assertEqual(compatibility_evidence('',None,expected)['runtime_compatibility'],'UNRUN')
        self.assertEqual(compatibility_evidence('',0,expected)['runtime_compatibility'],'UNRUN')
        self.assertEqual(compatibility_evidence(encode(good),1,expected)['runtime_compatibility'],'FAIL')
        for bad in (dict(good, secret='sentinel-secret'), dict(good,current_user='supabase_admin'),
                    dict(good,migration_versions=['sentinel-secret'])):
            with self.assertRaises(AssertionError): compatibility_evidence(encode(bad),0,expected)

    def test_policy_repro_requires_before_after_and_fresh_session(self):
        import json
        good = {'current_user':'postgres','session_user':'postgres',
                'policy_created':True,'sqlstate':None,'policy_absent':True,
                'supautils_registered':True}
        bad = dict(good, policy_created=False, sqlstate='42501')
        probe = lambda obj: 'X6_POLICY_PROBE ' + json.dumps(obj) + '\n'
        raw = probe(good) + 'X6_DUPLICATE {"duplicate_seen":true}\n' + probe(bad)
        report = policy_repro_evidence(raw, probe(good), 0, 0)
        self.assertEqual(report['reproduction'], 'REPRODUCED')
        self.assertEqual(report['policy_repro'], 'PASS')
        self.assertEqual(policy_repro_evidence(raw, '', 0, 1)['reproduction'], 'UNRUN')
        self.assertEqual(policy_repro_evidence(raw, probe(good), 1, 0)['reproduction'], 'UNRUN')
        self.assertEqual(policy_repro_evidence(probe(good), probe(good), 0, 0)['reproduction'], 'UNRUN')
        clean = probe(good) + 'X6_DUPLICATE {"duplicate_seen":true}\n' + probe(good)
        self.assertEqual(policy_repro_evidence(clean, probe(good), 0, 0)['reproduction'], 'NOT_REPRODUCED')
        dirty = dict(good, policy_absent=False)
        self.assertEqual(policy_repro_evidence(raw, probe(dirty), 0, 0)['policy_repro'], 'UNRUN')
        with self.assertRaises(AssertionError):
            policy_repro_evidence(raw, probe(dict(good, secret='sentinel-secret')), 0, 0)
        with self.assertRaises(AssertionError):
            policy_repro_evidence(raw, probe(dict(good, current_user='supabase_admin')), 0, 0)

    def test_pull_evidence_omits_sensitive_urls_and_messages(self):
        evidence = pull_evidence('toomanyrequests retry ghcr.io/supabase/postgres:17.6.1.064 https://private.example/?token=sentinel-secret')
        self.assertEqual(evidence, {'pull_reason':'rate_limited','public_images_mentioned':['ghcr.io/supabase/postgres:17.6.1.064']})

    def test_recovered_pull_error_is_not_terminal_failure(self):
        self.assertEqual(category("failed to pull image: toomanyrequests", 0), "startup_success")

    def test_full_chain_requires_exact_complete_sequence(self):
        names=['0000_base_schema.sql','0001_multi_channel.sql']
        self.assertEqual(chain_status(names,names,0),'PASS')
        self.assertEqual(chain_status(names,names[:1],0),'UNVERIFIED')
        self.assertEqual(chain_status(names,list(reversed(names)),0),'UNVERIFIED')
        self.assertEqual(chain_status(names,names,1),'FAIL')
        self.assertEqual(chain_status(names,[],1),'UNRUN')

    def test_terminal_categories(self):
        for raw, code, expected in [('',124,'startup_timeout'),('no space left on device',1,'disk_exhaustion'),('out of memory',1,'memory_exhaustion'),('ERROR SQLSTATE 42501',1,'migration_failure'),('container unhealthy',1,'container_health_failure'),('failed to pull image',1,'image_pull_failure'),('arbitrary error',137,'unknown_startup_failure')]:
            self.assertEqual(category(raw,code),expected)
    def test_raw_secret_never_becomes_evidence(self):
        self.assertIsNone(safe_evidence('password=sentinel-secret'))
        with self.assertRaises(AssertionError):
            safe_evidence('X6_EVIDENCE {"token":"sentinel-secret"}')
    def test_valid_migration_identity(self):
        import json
        obj={'current_user':'postgres','session_user':'postgres','superuser':False,'tables':[{'table':t,'owner':'supabase_storage_admin','owner_usage':False,'owner_member':False} for t in ['objects','buckets']],'memberships':[]}
        self.assertEqual(safe_evidence('NOTICE: X6_EVIDENCE '+json.dumps(obj)),obj)
        obj['supautils'] = {'version':None,'session_preloaded':False,'shared_preloaded':False,'objects_policy_grant':None,'buckets_policy_grant':None}
        self.assertEqual(safe_evidence('NOTICE: X6_EVIDENCE '+json.dumps(obj)),obj)
        obj['supautils']['version']='postgres://sentinel-secret'
        with self.assertRaises(AssertionError): safe_evidence('X6_EVIDENCE '+json.dumps(obj))
        obj.pop('supautils')
        obj['current_user']='postgres://secret'
        with self.assertRaises(AssertionError): safe_evidence('X6_EVIDENCE '+json.dumps(obj))

if __name__=='__main__': unittest.main()
