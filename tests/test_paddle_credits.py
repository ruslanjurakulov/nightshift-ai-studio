"""Buying credits with Paddle (migration 0021, the paddle-webhook Edge Function).

The behaviour itself is tested where it runs: the webhook's logic in the
Command Center's vitest suite (command-center/tests/paddle-webhook.test.ts),
and 0021 against a real Postgres when it was written. These pin the
properties that would quietly break if someone edited the files later:

* a browser able to call the refund or audit functions (anon/authenticated
  would then rewrite a balance or forge a "processed" purchase);
* a security-definer function without a pinned search_path;
* the service key, or the webhook secret, becoming something the Command
  Center reads;
* the webhook deployed with JWT verification on (Paddle would get 401 on
  every delivery) — the docs must say --no-verify-jwt.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0021_credit_refunds.sql").read_text(encoding="utf-8")
SHARED = (ROOT / "supabase" / "functions" / "_shared" / "paddle.ts").read_text(encoding="utf-8")
ENTRY = (ROOT / "supabase" / "functions" / "paddle-webhook" / "index.ts").read_text(encoding="utf-8")
DOCS = (ROOT / "docs" / "PADDLE_SETUP.md").read_text(encoding="utf-8")
APP = ROOT / "command-center"


class Migration0021(unittest.TestCase):
    def test_refund_and_audit_functions_are_service_role_only(self):
        for fn in (
            "record_payment_event(text, text, text, timestamptz, text, text, uuid, text, text, numeric, text, bigint)",
            "refund_purchased_credits(text, text, numeric, text, text)",
        ):
            with self.subTest(fn=fn):
                flat = re.sub(r"\s+", " ", SQL)
                self.assertIn(f"revoke all on function public.{fn} from public, anon, authenticated;", flat)
                self.assertIn(f"grant execute on function public.{fn} to service_role;", flat)
                self.assertNotRegex(flat, rf"grant execute on function public\.{re.escape(fn)} to [^;]*authenticated")

    def test_every_security_definer_function_pins_its_search_path(self):
        heads = re.findall(r"create or replace function (public\.\w+)\((.*?)\bas \$\$", SQL, re.S)
        definers = [(n, h) for n, h in heads if "security definer" in h]
        self.assertEqual(len(definers), 2)
        for name, head in definers:
            with self.subTest(fn=name):
                self.assertIn("set search_path = public, pg_temp", head)

    def test_browsers_get_no_table_access(self):
        self.assertIn(
            "revoke all on public.payment_events, public.credit_refunds from anon, authenticated, service_role;", SQL
        )
        self.assertNotRegex(SQL, r"grant [^;]* on public\.(payment_events|credit_refunds)[^;]* to [^;]*authenticated")

    def test_a_refund_never_takes_more_than_is_available(self):
        # The clamp that keeps 0020's balance >= 0 constraint true.
        self.assertIn("taken := least(asked, greatest(acc.balance - acc.reserved, 0));", SQL)

    def test_additive_only(self):
        self.assertNotRegex(SQL.lower(), r"\bdrop (table|column|function)\b")
        self.assertNotRegex(SQL.lower(), r"\balter table public\.credit_(accounts|transactions|reservations)\b")


class WebhookFunction(unittest.TestCase):
    def test_the_shared_logic_stays_runtime_neutral(self):
        # Deno runs it; vitest (node) tests it. Deno.* or a relative import
        # would break one of the two.
        code = "\n".join(l for l in SHARED.splitlines() if not l.lstrip().startswith(("//", "*", "/*")))
        self.assertNotIn("Deno.", code)
        self.assertNotRegex(SHARED, re.compile(r"^\s*import\s", re.M))

    def test_secrets_come_from_the_function_environment_only(self):
        for name in ("PADDLE_WEBHOOK_SECRET", "SUPABASE_SERVICE_ROLE_KEY"):
            with self.subTest(name=name):
                self.assertIn(f'env("{name}")', ENTRY)

    def test_the_command_center_never_reads_the_webhook_secret_or_service_key(self):
        for path in APP.rglob("*"):
            if "node_modules" in path.parts or ".next" in path.parts or path.suffix not in {".ts", ".tsx"}:
                continue
            text = path.read_text(encoding="utf-8")
            with self.subTest(path=str(path.relative_to(ROOT))):
                self.assertNotIn("PADDLE_WEBHOOK_SECRET", text)
                self.assertNotRegex(text, r"process\.env\.PADDLE_")

    def test_docs_deploy_without_jwt_verification(self):
        self.assertIn("supabase functions deploy paddle-webhook --no-verify-jwt", DOCS)
        self.assertIn("supabase secrets set", DOCS)


if __name__ == "__main__":
    unittest.main()
