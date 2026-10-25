"""Migration 0123 (the owner's vendor API keys in Vault), pinned from the file: what the lab cannot see by running it, and what must hold
on a machine with no Postgres.

* it replaces no existing function (in particular not audit_action_allowed: the audit action `secret.write` is reused), so there is no
  drift guard to compare and no other migration's body is touched;
* every function is revoked from every API role first and granted to `authenticated` only (never anon, never service_role), the helpers to
  nobody; both tables are revoked from every API role; the refs table has no policy; the status table has exactly one, owner-only;
* every security-definer function pins search_path to the empty string;
* the vendor list in the SQL equals the one in command-center/lib/model-keys.ts;
* the audit detail written by the functions never names the key or its last four characters;
* the number is free: no other migration on main uses it, and the file says why 0122 was skipped;
* the rollback exists, drops what the migration adds, destroys the Vault secrets first, and is one transaction;
* nothing outside the Command Center reads the vendor keys from Vault (workers keep using the environment).
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0123_model_api_keys.sql"
TEXT = FILE.read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0123_model_api_keys.sql").read_text(encoding="utf-8")
TS = (ROOT / "command-center" / "lib" / "model-keys.ts").read_text(encoding="utf-8")


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


CODE = code(TEXT)
FUNCTIONS = ["model_key_provider_ok", "model_key_owner_gate", "owner_model_key_store", "owner_model_key_remove", "owner_model_key_status"]
OWNER = ["owner_model_key_store", "owner_model_key_remove", "owner_model_key_status"]


class ModelApiKeysMigrationTests(unittest.TestCase):
    def test_it_replaces_nothing_that_exists(self):
        created = re.findall(r"create or replace function public\.(\w+)", CODE)
        self.assertEqual(sorted(created), sorted(FUNCTIONS))
        self.assertNotIn("audit_action_allowed(p_action", CODE)
        stripped = re.sub(r"(?i)alter table public\.model_api_key_(refs|status) enable row level security;|drop policy if exists model_api_key_status_select on public\.model_api_key_status;", "", CODE)
        self.assertNotRegex(stripped, r"(?i)\b(alter|drop)\s+(table|function|trigger|policy)\b")
        self.assertNotRegex(CODE, r"(?i)\binsert\s+into\s+public\.(?!model_api_key_|app_audit_log)")
        # the audit action it reuses must already be an allowed one (a DO block checks it live as well)
        self.assertIn("secret.write", (MIG / "0107_owner_safety.sql").read_text(encoding="utf-8"))
        self.assertIn("audit_action_allowed('secret.write')", CODE)

    def test_the_grants_are_authenticated_only_and_the_helpers_are_closed(self):
        revoked = set(re.findall(r"revoke all on function public\.(\w+)\(", CODE))
        self.assertEqual(revoked, set(FUNCTIONS))
        grants = re.findall(r"grant execute on function public\.(\w+)\([^)]*\) to ([^;]+);", CODE)
        self.assertEqual(sorted(g[0] for g in grants), sorted(OWNER))
        self.assertTrue(all(g[1].strip() == "authenticated" for g in grants), grants)
        self.assertNotIn("service_role;", re.sub(r"revoke[^;]*;", "", CODE))
        self.assertIn("revoke all on public.model_api_key_refs from public, anon, authenticated, service_role;", CODE)
        self.assertIn("revoke all on public.model_api_key_status from public, anon, authenticated, service_role;", CODE)
        self.assertIn("grant select on public.model_api_key_status to authenticated;", CODE)
        self.assertEqual(len(re.findall(r"(?i)\bgrant\s+(?!execute)", CODE)), 1)

    def test_rls_and_the_policies(self):
        self.assertIn("alter table public.model_api_key_refs enable row level security;", CODE)
        self.assertIn("alter table public.model_api_key_status enable row level security;", CODE)
        policies = re.findall(r"create policy (\w+) on public\.(\w+)", CODE)
        self.assertEqual(policies, [("model_api_key_status_select", "model_api_key_status")])
        self.assertIn("using ((select public.platform_role()) = 'owner')", CODE)
        self.assertIn("for select to authenticated", CODE)

    def test_every_function_pins_search_path_and_the_definers_check_the_owner(self):
        for name in FUNCTIONS:
            head = CODE[CODE.index(f"function public.{name}"):][:600]
            self.assertIn("set search_path = ''", head, name)
        for name in OWNER:
            fn = CODE[CODE.index(f"function public.{name}"):]
            fn = fn[:fn.index("\n$$;")]
            self.assertIn("security definer", fn, name)
            self.assertIn("model_key_owner_gate(", fn, name)
        gate = CODE[CODE.index("function public.model_key_owner_gate"):]
        gate = gate[:gate.index("\n$$;")]
        self.assertIn("public.platform_role() is distinct from 'owner'", gate)
        self.assertIn("errcode = '42501'", gate)

    def test_a_validation_failure_is_returned_not_raised(self):
        store = CODE[CODE.index("function public.owner_model_key_store"):]
        store = store[:store.index("\n$$;")]
        self.assertNotIn("raise exception", store)
        self.assertEqual(len(re.findall(r"owner_err\('(unknown_provider|bad_status|bad_key)'", store)), 3)

    def test_the_key_is_neither_audited_nor_returned(self):
        for name in OWNER:
            fn = CODE[CODE.index(f"function public.{name}"):]
            fn = fn[:fn.index("\n$$;")]
            audit = re.findall(r"owner_audit\((.*?)\);", fn, re.S)
            for a in audit:
                self.assertNotIn("p_secret", a, name)
                self.assertNotIn("last4", a, name)
                self.assertNotIn("right(", a, name)
            ret = re.findall(r"return jsonb_build_object\((.*?)\);", fn, re.S)
            for r in ret:
                self.assertNotIn("p_secret", r, name)
                self.assertNotIn("vault_secret_id", r, name)
                self.assertNotIn("sid", r, name)
        # no function reads the key back
        self.assertNotRegex(CODE, r"(?i)(from|join)\s+vault\.decrypted_secrets")
        self.assertNotRegex(CODE, r"(?i)\bdecrypted_secret\b")
        self.assertEqual(CODE.count("decrypted_secrets"), 1, "only the existence check of the prerequisites block")

    def test_the_key_shape_is_the_one_the_page_checks(self):
        self.assertIn("char_length(p_secret) not between 16 and 512", CODE)
        self.assertIn(r"p_secret !~ '^[\x21-\x7e]+$'", CODE)
        self.assertIn("MODEL_KEY_MIN_CHARS = 16", TS)
        self.assertIn("MODEL_KEY_MAX_CHARS = 512", TS)

    def test_the_vendor_list_is_the_one_of_the_page(self):
        fn = CODE[CODE.index("function public.model_key_provider_ok"):]
        sql_ids = re.findall(r"'([a-z0-9-]+)'", fn[:fn.index("\n$$;")])
        ts = TS[TS.index("MODEL_KEY_PROVIDER_IDS = ["):]
        ts_ids = re.findall(r'"([a-z0-9-]+)"', ts[:ts.index("] as const")])
        self.assertEqual(sorted(sql_ids), sorted(ts_ids))
        self.assertEqual(len(sql_ids), 13)

    def test_the_number_is_free_and_the_header_says_why_0122_was_skipped(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0123"), 1)
        self.assertIn("0122 is taken by the branch claude/series-template-carrier", TEXT)

    def test_it_is_one_transaction_applied_by_the_runner_and_replays(self):
        self.assertIn("set local lock_timeout = '5s';", CODE)
        self.assertIn("APPLY AS ONE TRANSACTION", TEXT)
        self.assertNotRegex(CODE, r"(?m)^\s*(begin|commit);")
        for stmt in re.findall(r"(?im)^create (?:table|index)(?! if not exists)\b.*", CODE):
            self.fail(f"not replay-safe: {stmt}")

    def test_the_rollback_destroys_the_secrets_then_drops_everything_it_added(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertRegex(ROLLBACK, r"(?m)^commit;$")
        rb = code(ROLLBACK)
        self.assertLess(rb.index("vault.update_secret"), rb.index("drop table if exists public.model_api_key_refs"))
        self.assertLess(rb.index("vault.update_secret"), rb.index("delete from vault.secrets"))
        for name in FUNCTIONS:
            self.assertRegex(rb, rf"drop function if exists public\.{name}\(")
        self.assertLess(rb.index("drop table if exists public.model_api_key_status"), rb.index("drop function if exists public.model_key_provider_ok"))
        self.assertIn("drop policy if exists model_api_key_status_select", rb)
        self.assertNotIn("audit_action_allowed", rb)

    def test_only_the_command_center_stores_these_keys_and_no_worker_reads_them(self):
        needles = ("owner_model_key_store", "owner_model_key_remove", "owner_model_key_status", "model_api_key_refs", "model_api_key_status")
        skip = {"node_modules", ".next", "tests", "docs", "migrations", ".git"}
        hits = []
        for path in ROOT.rglob("*"):
            if not path.is_file() or path.suffix not in {".py", ".ts", ".tsx", ".yml", ".yaml", ".sh", ".mjs", ".js"}:
                continue
            rel = path.relative_to(ROOT)
            if any(part in skip for part in rel.parts) or rel.parts[0] == "tests":
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if any(n in text for n in needles):
                hits.append(str(rel))
        self.assertEqual(sorted(hits), ["command-center/lib/server/model-keys.ts"])


if __name__ == "__main__":
    unittest.main()
