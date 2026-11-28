"""Paddle sandbox on a production database: the wiring that would quietly reopen the hole if someone edited it later.

The behaviour is tested where it runs, in the Command Center's vitest suite (command-center/tests/paddle-webhook.test.ts,
api-topup-webhook.test.ts, paddle-subscriptions.test.ts, paddle.test.ts, paddle-sandbox-topup.test.ts). A function deployed
with the sandbox destination's secret verifies a sandbox delivery exactly like a live one, and a sandbox test card is
public, so before PADDLE_WEBHOOK_ENV any owner could buy real credits with it. These pin:

* the Edge Function reading PADDLE_WEBHOOK_ENV and PADDLE_TEST_ORG_IDS and handing both to the handler;
* the handler's environment having no safe-looking default (empty must not mean production);
* the Command Center reading the list server-side only (never a NEXT_PUBLIC_ variable), and the deploy mapping it;
* the setup guide telling the owner that the function must be redeployed by hand.
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENTRY = (ROOT / "supabase" / "functions" / "paddle-webhook" / "index.ts").read_text(encoding="utf-8")
SHARED = (ROOT / "supabase" / "functions" / "_shared" / "paddle.ts").read_text(encoding="utf-8")
DOCS = (ROOT / "docs" / "PADDLE_SETUP.md").read_text(encoding="utf-8")
DEPLOY = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text(encoding="utf-8")
ENV_EXAMPLE = (ROOT / "deploy" / ".env.web.example").read_text(encoding="utf-8")
SERVER_PAYMENTS = (ROOT / "command-center" / "lib" / "server" / "payments.ts").read_text(encoding="utf-8")


class EdgeFunctionWiring(unittest.TestCase):
    def test_reads_the_environment_and_the_list_and_passes_both_to_the_handler(self):
        self.assertIn('paddleWebhookEnvFromEnv(env("PADDLE_WEBHOOK_ENV"))', ENTRY)
        self.assertIn('paddleTestOrgsFromEnv(env("PADDLE_TEST_ORG_IDS"))', ENTRY)
        call = ENTRY.split("handlePaddleWebhook(")[-1]
        self.assertIn("mode", call)
        self.assertIn("testOrgs", call)

    def test_the_handler_requires_both_rather_than_defaulting(self):
        deps = SHARED.split("export async function handlePaddleWebhook(")[1].split("): Promise<WebhookResponse>")[0]
        self.assertIn("mode: PaddleWebhookEnv;", deps)
        self.assertIn("testOrgs: ReadonlySet<string>;", deps)
        self.assertNotIn("mode?:", deps)

    def test_empty_is_not_production(self):
        reader = SHARED.split("export function paddleWebhookEnvFromEnv")[1].split("\n}\n")[0]
        self.assertIn('v === "production" ? "production"', reader)
        self.assertIn(': "unknown"', reader)


class CommandCenterWiring(unittest.TestCase):
    def test_the_list_is_server_only_and_mapped_by_the_deploy(self):
        self.assertIn("process.env.PADDLE_TEST_ORG_IDS", SERVER_PAYMENTS)
        self.assertNotIn("NEXT_PUBLIC_PADDLE_TEST_ORG_IDS", ENV_EXAMPLE + DEPLOY + SERVER_PAYMENTS)
        self.assertIn("\nPADDLE_TEST_ORG_IDS=\n", ENV_EXAMPLE)
        self.assertIn("WEBENV_PADDLE_TEST_ORG_IDS: ${{ vars.PADDLE_TEST_ORG_IDS }}\n", DEPLOY)


class SetupGuide(unittest.TestCase):
    def test_names_both_secrets_and_the_manual_redeploy(self):
        for name in ("PADDLE_WEBHOOK_ENV=sandbox", "PADDLE_WEBHOOK_ENV=production", "PADDLE_TEST_ORG_IDS="):
            self.assertIn(name, DOCS)
        self.assertIn("avtomatik deploy qilinmaydi", DOCS)
        self.assertIn("supabase functions deploy paddle-webhook --no-verify-jwt", DOCS)


if __name__ == "__main__":
    unittest.main()
