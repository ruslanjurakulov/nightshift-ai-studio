"""Migration 0134 (the brand scan's follow-up), pinned from the files: what the security lab cannot see by running it.

* the hashes: the guard names 0133's body (recomputed from 0133's file) and 0134's own, the end state and the rollback name the same ones;
* the body is 0133's plus the lock and the two reference checks, nothing else; it takes no advisory lock (0131's lock order);
* the rollback puts 0133's body back character for character, in one transaction;
* it creates, alters and grants nothing else, and never sets the price.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
TEXT = (MIG / "0134_brand_scan_followup.sql").read_text(encoding="utf-8")
T0133 = (MIG / "0133_brand_scan.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0134_brand_scan_followup.sql").read_text(encoding="utf-8")
NAME = "create or replace function public.brand_scan_fail_locked("


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def definition(sql: str) -> str:
    i = sql.index(NAME)
    return sql[i:sql.index("$$;", sql.index("$$", i) + 2) + 3]


def body_md5(sql: str) -> str:
    d = definition(sql)
    a = d.index("$$") + 2
    return hashlib.md5(re.sub(r"\s+", " ", d[a:d.rindex("$$")]).encode()).hexdigest()


MD5_0133 = body_md5(T0133)
MD5_0134 = body_md5(TEXT)


class Hashes(unittest.TestCase):
    def test_the_guard_names_0133s_body_and_its_own(self):
        self.assertEqual(MD5_0133, "67e8ee83bde9ec4512a3d6135c9c07ee")
        self.assertIn(f"got <> all (array['{MD5_0133}', '{MD5_0134}'])", TEXT)

    def test_the_end_state_and_the_rollback_name_the_same_hashes(self):
        self.assertIn(f"if got <> '{MD5_0134}' then", TEXT)
        self.assertIn(f"got <> all (array['{MD5_0134}', '{MD5_0133}'])", ROLLBACK)
        self.assertIn(f"<> '{MD5_0133}' then", ROLLBACK)
        self.assertEqual(sorted(set(re.findall(r"[0-9a-f]{32}", code(TEXT)))), sorted({MD5_0133, MD5_0134}))
        self.assertEqual(sorted(set(re.findall(r"[0-9a-f]{32}", code(ROLLBACK)))), sorted({MD5_0133, MD5_0134}))

    def test_the_rollback_puts_0133s_definition_back_verbatim_in_one_transaction(self):
        self.assertEqual(definition(ROLLBACK), definition(T0133))
        self.assertEqual(body_md5(ROLLBACK), MD5_0133)
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertIn("revoke all on function public.brand_scan_fail_locked(uuid, text) from public, anon, authenticated, service_role;", ROLLBACK)


class Body(unittest.TestCase):
    def test_it_is_0133s_body_plus_the_lock_and_the_two_reference_checks(self):
        old, new = definition(T0133), definition(TEXT)
        head = old[:old.index("  if x.id is not null then\n    update public.media_assets")]
        self.assertTrue(new.startswith(head), "everything before the delete is 0133's")
        b = code(new)
        self.assertIn("for update;", b)
        lock, delete = b.index("for update;"), b.index("update public.media_assets m")
        self.assertLess(lock, delete, "the pictures are locked in a statement before the delete")
        for check in ("and not exists (select 1 from public.brand_kits k where k.logo_asset_id = m.id)",
                      "and not exists (select 1 from public.brand_product_images i where i.asset_id = m.id)"):
            self.assertIn(check, b[delete:])
        for flt in ("org_id = x.org_id", "source = 'pipeline'", "deleted_at is null", "provenance ->> 'origin' = 'brand_scan'",
                    "provenance ->> 'scan_id' = x.id::text"):
            self.assertEqual(b.count(flt), 2, f"{flt}: in the lock and in the delete")
        self.assertNotIn("advisory", b, "0131's lock order: no advisory lock while the caller holds the scan's row lock")
        self.assertIn("language plpgsql volatile security definer set search_path = public, pg_temp as $$", new)

    def test_the_catalogue_guard_names_exactly_the_two_picture_columns(self):
        self.assertIn("if found <> array['brand_kits.logo_asset_id', 'brand_product_images.asset_id'] then", TEXT)
        for t in ("brand_kits", "brand_products", "brand_product_images", "ad_campaigns", "ad_campaign_products", "ad_concepts"):
            self.assertIn(f"'public.{t}'::regclass", TEXT)


class Scope(unittest.TestCase):
    def test_one_function_nothing_else(self):
        c = code(TEXT)
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", c), ["brand_scan_fail_locked"])
        self.assertNotRegex(c, r"\b(create table|alter table|create policy|create trigger|drop |create index)\b")
        self.assertNotRegex(c, r"\bgrant\b")
        self.assertIn("revoke all on function public.brand_scan_fail_locked(uuid, text) from public, anon, authenticated, service_role;", c)

    def test_it_never_sets_the_price(self):
        self.assertNotIn("brand_scan_settings", code(TEXT))
        self.assertNotIn("credit_prices", code(TEXT))

    def test_the_header(self):
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "LOCK ORDER", "set local lock_timeout",
                       "0132 is taken by an open pull request"):
            self.assertIn(needle, TEXT)


if __name__ == "__main__":
    unittest.main()
