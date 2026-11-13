"""Migration 0144 (Dodo Payments next to Paddle), pinned as text.

What would break: a provider-aware twin that drifts from 0034's body (two ledgers that disagree on what a plan period
grants), a Paddle wrapper that passes its arguments in another order, a Paddle id check that admits a shape 0034
refused, a rollback that does not put 0034 back byte for byte, or md5 pins that no longer describe the file. The lab
(tests/security/test_sec_dodo_payments.py) runs the same file on a real Postgres; this test needs none.
"""

from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
M0034 = (ROOT / "supabase" / "migrations" / "0034_plans_entitlements.sql").read_text(encoding="utf-8")
M0144 = (ROOT / "supabase" / "migrations" / "0144_dodo_payments.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0144_dodo_payments.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")


def definition(text: str, name: str) -> str:
    """`create or replace function public.<name>(` up to the `$$;` that closes its body."""
    m = re.search(rf"^create or replace function public\.{re.escape(name)}\(.*?^\$\$;$", text, re.S | re.M)
    assert m, name
    return m.group(0)


def body(defn: str) -> str:
    return defn.split("as $$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5(defn: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", body(defn)).encode()).hexdigest()


def with_provider(src: str, name: str) -> str:
    """0034's body with exactly the hunks 0144's header lists."""
    out = src.replace(f"create or replace function public.{name}(\n  p_org uuid,",
                      f"create or replace function public.{name}_for(\n  p_provider text, p_org uuid,", 1)
    i = out.index("  end if;\n") + len("  end if;\n")
    out = (out[:i] + "  if p_provider is null or p_provider not in ('paddle', 'dodo') then\n"
           "    raise exception 'unknown payment provider %', p_provider using errcode = '22023';\n"
           "  end if;\n" + out[i:])
    pairs = [
        ("hashtextextended('subscription:' || coalesce(p_subscription_id, ''), 0)",
         "hashtextextended('subscription:' || case when p_provider = 'paddle' then '' else p_provider || ':' end\n"
         "                                           || coalesce(p_subscription_id, ''), 0)"),
        ("where provider = 'paddle' and provider_subscription_id = p_subscription_id",
         "where provider = p_provider and provider_subscription_id = p_subscription_id"),
        ("(org_id, provider_subscription_id, provider_customer_id, plan_id, price_id, status,",
         "(provider, org_id, provider_subscription_id, provider_customer_id, plan_id, price_id, status,"),
        ("(p_org, p_subscription_id, p_customer_id, p_plan,", "(p_provider, p_org, p_subscription_id, p_customer_id, p_plan,"),
    ]
    for old, new in pairs:
        assert out.count(old) == 1, (name, old)
        out = out.replace(old, new)
    return out


PINS = {
    "upsert_subscription@0034": "60ee6ad3764dbcf6762b178f8240d5a9",
    "grant_subscription_credits@0034": "7947d46697f1c35d12274ffbe22709ac",
    "upsert_subscription": "09185a96a8fb02f0c2641095d51461cc",
    "grant_subscription_credits": "fd0c1c169a4d3b2d05c6d826c6fe10ff",
    "upsert_subscription_for": "9f9b399ce3ca3421d1ccb32c4075d6ea",
    "grant_subscription_credits_for": "5424905376fab9ff1b4c229c5dc0c0ce",
}


class ProviderAwareTwins(unittest.TestCase):
    def test_each_twin_is_0034s_body_plus_the_listed_hunks_byte_for_byte(self):
        for name in ("upsert_subscription", "grant_subscription_credits"):
            self.assertEqual(definition(M0144, f"{name}_for"), with_provider(definition(M0034, name), name), name)

    def test_the_paddle_wrappers_pass_paddle_and_every_argument_in_order(self):
        up = body(definition(M0144, "upsert_subscription"))
        self.assertIn("return public.upsert_subscription_for('paddle', p_org, p_subscription_id, p_customer_id, p_plan, p_price_id,", up)
        self.assertIn("p_status, p_period_start, p_period_end,", up)
        self.assertIn("p_cancel_at_period_end, p_canceled_at, p_occurred_at);", up)
        gr = body(definition(M0144, "grant_subscription_credits"))
        self.assertIn("return public.grant_subscription_credits_for('paddle', p_org, p_subscription_id, p_plan, p_period_start, p_period_end,", gr)
        self.assertIn("p_external_id, p_note, p_customer_id, p_price_id, p_paid_share);", gr)

    def test_the_wrappers_keep_0034s_signatures_and_defaults(self):
        for name in ("upsert_subscription", "grant_subscription_credits"):
            old = definition(M0034, name).split("as $$", 1)[0]
            new = definition(M0144, name).split("as $$", 1)[0]
            self.assertEqual(old, new, name)

    def test_the_md5_pins_describe_the_bodies_in_the_files(self):
        self.assertEqual(pg_md5(definition(M0034, "upsert_subscription")), PINS["upsert_subscription@0034"])
        self.assertEqual(pg_md5(definition(M0034, "grant_subscription_credits")), PINS["grant_subscription_credits@0034"])
        for name in ("upsert_subscription", "grant_subscription_credits", "upsert_subscription_for", "grant_subscription_credits_for"):
            self.assertEqual(pg_md5(definition(M0144, name)), PINS[name], name)
        for value in PINS.values():
            self.assertIn(value, M0144)

    def test_the_twins_are_service_role_only(self):
        for sig in ("upsert_subscription_for(text, uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)",
                    "grant_subscription_credits_for(text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)"):
            self.assertIn(f"revoke all on function public.{sig}\n  from public, anon, authenticated;", M0144)
            self.assertIn(f"grant execute on function public.{sig}\n  to service_role;", M0144)
            self.assertNotRegex(M0144, rf"grant execute on function public\.{re.escape(sig)}\s+to [^;]*(authenticated|anon)")


class Checks(unittest.TestCase):
    def test_a_paddle_row_keeps_exactly_0034s_id_patterns(self):
        for pattern in ("provider = 'paddle' and provider_subscription_id ~ '^sub_[a-z0-9]{10,40}$'",
                        "provider = 'paddle' and provider_customer_id ~ '^ctm_[a-z0-9]{10,40}$'",
                        "provider = 'paddle' and price_id ~ '^pri_[a-z0-9]{10,40}$'"):
            self.assertIn(pattern, M0144)
        for old in ("provider_subscription_id ~ '^sub_[a-z0-9]{10,40}$'", "provider_customer_id ~ '^ctm_[a-z0-9]{10,40}$'",
                    "price_id ~ '^pri_[a-z0-9]{10,40}$'"):
            self.assertIn(old, M0034)

    def test_only_paddle_and_dodo_are_providers(self):
        self.assertEqual(re.findall(r"check \(provider in \(([^)]*)\)\)", M0144), ["'paddle', 'dodo'", "'paddle', 'dodo'"])


class Rollback(unittest.TestCase):
    def test_puts_0034s_bodies_back_byte_for_byte(self):
        for name in ("upsert_subscription", "grant_subscription_credits"):
            self.assertEqual(definition(ROLLBACK, name), definition(M0034, name), name)

    def test_refuses_while_dodo_rows_exist_and_runs_as_one_transaction(self):
        self.assertIn("exists (select 1 from public.payment_events where provider = 'dodo')", ROLLBACK)
        self.assertIn("exists (select 1 from public.subscriptions where provider = 'dodo')", ROLLBACK)
        self.assertTrue(ROLLBACK.lstrip().splitlines()[0].startswith("-- rollback_0144"))
        self.assertIn("\nbegin;\n", ROLLBACK)
        self.assertTrue(ROLLBACK.rstrip().endswith("commit;"))

    def test_the_migration_is_documented(self):
        self.assertIn("0144_dodo_payments.sql", MIGRATIONS_DOC)
        self.assertIn("rollback_0144_dodo_payments.sql", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()
