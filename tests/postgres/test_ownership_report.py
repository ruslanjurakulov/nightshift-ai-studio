import unittest
from ownership_report import category, safe_evidence, pull_evidence

class ReportTests(unittest.TestCase):
    def test_pull_evidence_omits_sensitive_urls_and_messages(self):
        evidence = pull_evidence('toomanyrequests retry ghcr.io/supabase/postgres:17.6.1.064 https://private.example/?token=sentinel-secret')
        self.assertEqual(evidence, {'pull_reason':'rate_limited','public_images_mentioned':['ghcr.io/supabase/postgres:17.6.1.064']})

    def test_recovered_pull_error_is_not_terminal_failure(self):
        self.assertEqual(category("failed to pull image: toomanyrequests", 0), "startup_success")

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
        obj['current_user']='postgres://secret'
        with self.assertRaises(AssertionError): safe_evidence('X6_EVIDENCE '+json.dumps(obj))

if __name__=='__main__': unittest.main()
