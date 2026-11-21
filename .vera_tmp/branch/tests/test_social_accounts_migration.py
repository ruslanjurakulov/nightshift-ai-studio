"""supabase/migrations/0028_social_accounts.sql — Instagram / TikTok accounts.

SQL does not run in CI, so these pin the properties that matter: RLS is on,
no token is in a readable column, the secret table is locked for every API
role, EXECUTE is revoked from anon/authenticated on the runner's functions,
and every security-definer function pins its search_path."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0028_social_accounts.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())


def table_body(name):
    m = re.search(rf"create table if not exists public\.{name} \((.*?)\n\);", CODE, re.S)
    assert m, name
    return m.group(1)


class SocialAccountsMigration(unittest.TestCase):
    def test_accounts_table_has_no_token_column(self):
        body = table_body("social_accounts").lower()
        self.assertNotRegex(body, r"\b\w*(token|secret)\w*\s+(text|uuid)")
        self.assertIn("platform in ('instagram', 'tiktok')", body)
        self.assertIn("org_id", body)
        self.assertIn("unique (org_id, platform, external_id)", body)

    def test_rls_on_both_tables_and_select_is_by_org_membership(self):
        self.assertIn("alter table public.social_accounts enable row level security;", CODE)
        self.assertIn("alter table public.social_account_secrets enable row level security;", CODE)
        self.assertRegex(
            CODE,
            r"create policy social_accounts_select on public\.social_accounts\s+for select to authenticated\s+"
            r"using \(org_id in \(select public\.accessible_org_ids\('viewer'\)\)\);",
        )
        # No write policy: rows are written by the definer functions only.
        self.assertEqual(re.findall(r"create policy \w+ on public\.social_accounts\s+for (\w+)", CODE), ["select"])
        self.assertNotRegex(CODE, r"create policy \w+ on public\.social_account_secrets")

    def test_authenticated_can_only_select_accounts_and_nothing_on_secrets(self):
        self.assertIn("revoke all on public.social_accounts from public, anon, authenticated;", CODE)
        self.assertIn("grant select on public.social_accounts to authenticated;", CODE)
        self.assertNotRegex(CODE, r"grant [^;]*(insert|update|delete)[^;]* on public\.social_accounts to [^;]*authenticated")
        self.assertIn(
            "revoke all on public.social_account_secrets from public, anon, authenticated, service_role;", CODE)
        self.assertNotRegex(CODE, r"grant [^;]* on public\.social_account_secrets")

    def test_tokens_live_in_vault(self):
        self.assertIn("vault.create_secret(", CODE)
        self.assertIn("vault.update_secret(", CODE)
        self.assertIn("join vault.decrypted_secrets", CODE)

    def test_execute_revoked_then_granted_narrowly(self):
        fns = re.findall(r"create or replace function (public\.\w+)\(", CODE)
        for fn in fns:
            self.assertRegex(CODE, rf"revoke all on function {re.escape(fn)}\([^)]*\) from public, anon, authenticated, service_role;", fn)
        grants = dict(re.findall(r"grant execute on function (public\.\w+)\([^)]*\) to ([^;]+);", CODE))
        self.assertEqual(grants, {
            "public.store_social_account": "authenticated",
            "public.revoke_social_account": "authenticated, service_role",
            "public.read_social_token": "service_role",
            "public.rotate_social_token": "service_role",
            "public.set_social_account_status": "service_role",
        })
        for name in ("read_social_token", "rotate_social_token", "set_social_account_status"):
            body = CODE.split(f"function public.{name}(", 1)[1].split("$$;", 1)[0]
            self.assertIn("if not public.social_trusted_caller() then", body, name)

    def test_store_requires_signed_in_org_editor_and_known_scopes(self):
        body = CODE.split("function public.store_social_account(", 1)[1].split("$$;", 1)[0]
        self.assertIn("if me is null then", body)
        self.assertIn("not public.is_org_member(p_org_id, 'editor')", body)
        self.assertIn("granted <@ public.social_allowed_scopes(p_platform)", body)
        self.assertIn("meta has an unknown key", body)
        # Returns ids and status only.
        ret = body.rsplit("return jsonb_build_object(", 1)[1]
        self.assertNotRegex(ret, r"token|secret")

    def test_definer_functions_pin_search_path(self):
        for m in re.finditer(r"create or replace function (public\.\w+)\((.*?)\$\$", CODE, re.S):
            header = m.group(2)
            if "security definer" in header:
                self.assertIn("set search_path = ''", header, m.group(1))

    def test_is_additive(self):
        self.assertNotRegex(CODE, r"\bdrop (table|function|column)\b")
        self.assertNotRegex(CODE, r"alter table public\.(channels|videos|organizations)\b")


if __name__ == "__main__":
    unittest.main()
