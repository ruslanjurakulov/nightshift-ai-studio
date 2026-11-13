"""Selling through Dodo Payments: the properties that would quietly break if someone edited the files later.

The behaviour is tested where it runs: the webhook's logic and the checkout route in the Command Center's vitest suite
(command-center/tests/dodo-webhook.test.ts, dodo-checkout.test.ts, dodo-ui.test.tsx) and migration 0144 against a real
PostgreSQL (tests/security/test_sec_dodo_payments.py). These pin:

* the webhook secret or the service key becoming something the Command Center reads, or the Dodo API key being read
  anywhere but the one server-only module (a browser bundle would then carry it);
* a Dodo setting turned into a NEXT_PUBLIC_ variable (inlined into every page);
* the Edge Function verifying anything but the three Standard Webhooks headers, or reading the body without the cap;
* the switch defaulting to anything but Paddle in the deploy, or the deploy carrying the API key as a variable;
* the setup guide losing --no-verify-jwt (Dodo would get 401 on every delivery) or the list of events to tick.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENTRY = (ROOT / "supabase" / "functions" / "dodo-webhook" / "index.ts").read_text(encoding="utf-8")
SHARED = (ROOT / "supabase" / "functions" / "_shared" / "dodo.ts").read_text(encoding="utf-8")
DOCS = (ROOT / "docs" / "DODO_SETUP.md").read_text(encoding="utf-8")
DEPLOY = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text(encoding="utf-8")
ENV_EXAMPLE = (ROOT / "deploy" / ".env.web.example").read_text(encoding="utf-8")
APP = ROOT / "command-center"


def app_sources():
    for path in APP.rglob("*"):
        if path.suffix not in (".ts", ".tsx") or "node_modules" in path.parts or ".next" in path.parts or "tests" in path.parts:
            continue
        yield path, path.read_text(encoding="utf-8")


class EdgeFunction(unittest.TestCase):
    def test_reads_the_three_standard_webhooks_headers_and_caps_the_body_before_verifying(self):
        for header in ("webhook-id", "webhook-timestamp", "webhook-signature"):
            self.assertIn(f'req.headers.get("{header}")', ENTRY)
        self.assertLess(ENTRY.index("readBodyCapped(req)"), ENTRY.index("handleDodoWebhook("))
        self.assertNotIn("req.text()", ENTRY)
        self.assertNotIn("req.json()", ENTRY)

    def test_the_secret_and_the_service_key_are_read_only_here(self):
        self.assertIn('env("DODO_WEBHOOK_SECRET")', ENTRY)
        for name in ("DODO_METADATA_SECRET", "DODO_TAX_MODE", "DODO_WEBHOOK_MODE", "DODO_TEST_ORG_IDS"):
            self.assertIn(f'env("{name}")', ENTRY)
        self.assertIn('env("SUPABASE_SERVICE_ROLE_KEY")', ENTRY)
        # Nothing is logged but names and reasons: no template that interpolates the secret, a header or the body.
        for line in ENTRY.splitlines() + SHARED.splitlines():
            if re.search(r"\blog\.(info|warn|error)\(|console\.(log|info|warn|error)\(", line):
                self.assertNotRegex(line, r"\$\{\s*(secret|serviceKey|key|rawBody|req\.rawBody|req\.headers|headers)\b", line)

    def test_constant_time_compare_and_the_five_minute_window(self):
        verify = SHARED.split("export async function verifyDodoSignature")[1].split("\n}\n")[0]
        # The comparison is SubtleCrypto's verify(): never a computed signature compared as a string or byte by byte.
        self.assertIn('crypto.subtle.verify("HMAC"', verify)
        self.assertNotIn("crypto.subtle.sign", verify)
        self.assertNotRegex(verify, r"===\s*s\b|s\s*===|toString\(|btoa\(")
        self.assertIn("SIGNATURE_TOLERANCE_S = 300", SHARED)
        self.assertIn("Math.abs(nowSeconds - Number(ts)) > toleranceS", verify)


class CommandCenter(unittest.TestCase):
    def test_never_reads_the_webhook_secret_or_the_service_key(self):
        for path, text in app_sources():
            with self.subTest(path=path.relative_to(APP).as_posix()):
                self.assertNotIn("DODO_WEBHOOK_SECRET", text)
                self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", text)

    def test_the_dodo_api_key_and_the_metadata_secret_are_read_in_one_server_only_module(self):
        for name in ("DODO_PAYMENTS_API_KEY", "DODO_METADATA_SECRET"):
            readers = [path.relative_to(APP).as_posix() for path, text in app_sources() if f"process.env.{name}" in text]
            self.assertEqual(readers, ["lib/server/dodo-api.ts"], name)
        self.assertTrue((APP / "lib" / "server" / "dodo-api.ts").read_text(encoding="utf-8").startswith('import "server-only";'))
        self.assertTrue((APP / "lib" / "server" / "payments.ts").read_text(encoding="utf-8").startswith('import "server-only";'))

    def test_no_dodo_setting_is_a_public_variable(self):
        for path, text in app_sources():
            with self.subTest(path=path.relative_to(APP).as_posix()):
                self.assertNotRegex(text, r"NEXT_PUBLIC_(DODO|PAYMENTS_PROVIDER)")
        self.assertNotRegex(ENV_EXAMPLE, r"NEXT_PUBLIC_(DODO|PAYMENTS_PROVIDER)")


class Deploy(unittest.TestCase):
    def test_the_switch_is_a_variable_with_no_default_and_the_key_is_a_secret(self):
        self.assertIn("WEBENV_PAYMENTS_PROVIDER: ${{ vars.PAYMENTS_PROVIDER }}\n", DEPLOY)
        self.assertIn("WEBENV_DODO_PAYMENTS_API_KEY: ${{ secrets.DODO_PAYMENTS_API_KEY }}\n", DEPLOY)
        for name in ("DODO_PRODUCT_STARTER", "DODO_PRODUCT_CREATOR", "DODO_PRODUCT_STUDIO", "DODO_PLAN_CREATOR", "DODO_PLAN_PRO", "DODO_PLAN_STUDIO", "DODO_PAYMENTS_ENV"):
            self.assertIn(f"WEBENV_{name}: ${{{{ vars.{name} }}}}\n", DEPLOY)
        self.assertNotIn("vars.DODO_PAYMENTS_API_KEY", DEPLOY)
        self.assertIn("WEBENV_DODO_METADATA_SECRET: ${{ secrets.DODO_METADATA_SECRET }}\n", DEPLOY)
        self.assertNotIn("vars.DODO_METADATA_SECRET", DEPLOY)
        self.assertIn("WEBENV_DODO_TEST_ORG_IDS: ${{ vars.DODO_TEST_ORG_IDS }}\n", DEPLOY)
        self.assertNotIn("DODO_WEBHOOK_SECRET", DEPLOY)
        self.assertRegex(ENV_EXAMPLE, r"(?m)^PAYMENTS_PROVIDER=$")


class SetupGuide(unittest.TestCase):
    def test_deploys_without_jwt_verification_and_sets_the_secrets_by_name(self):
        self.assertIn("supabase functions deploy dodo-webhook --no-verify-jwt", DOCS)
        for name in ("DODO_WEBHOOK_SECRET", "DODO_PRODUCT_STARTER", "DODO_PLAN_PRO", "DODO_PAYMENTS_API_KEY", "PAYMENTS_PROVIDER",
                     "DODO_METADATA_SECRET", "DODO_TAX_MODE", "DODO_WEBHOOK_MODE", "DODO_TEST_ORG_IDS"):
            self.assertIn(name, DOCS)
        self.assertNotRegex(DOCS, r"whsec_[A-Za-z0-9+/]{8,}|dodo_(test|live)_[A-Za-z0-9]{8,}")

    def test_lists_every_event_the_webhook_handles(self):
        handled = re.findall(r'"((?:payment|refund|dispute|subscription)\.[a-z_]+)"', SHARED.split("DODO_HANDLED_EVENTS")[0] + SHARED.split("DODO_HANDLED_EVENTS = [")[1].split("]")[0])
        self.assertGreaterEqual(len(set(handled)), 15)
        for event in set(handled):
            self.assertIn(f"`{event}`", DOCS, event)


if __name__ == "__main__":
    unittest.main()
