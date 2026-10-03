"""Static pins for migration 0093 (MCP over OAuth).

The database half is attacked in tests/security/test_sec_mcp_oauth.py; these are
the checks that need no database and that fail loudly in review when a later
edit breaks a rule the lab only notices when it runs:

* api_begin is 0062's body with exactly ONE change, so no earlier check of the
  API-key door was dropped (the rule for every `create or replace` here);
* audit_action_allowed is 0087's list plus this file's four actions;
* an OAuth caller can never reach the prepaid USD balance: the allow-list in
  oauth_endpoint_scope, and no USD table named in a function a token reaches;
* every function pins its search_path, every table has RLS and no grant, every
  grant is the one the security lab declares.
"""

import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
SQL = (MIGRATIONS / "0093_mcp_oauth.sql").read_text(encoding="utf-8")
SQL_0062 = (MIGRATIONS / "0062_api_creative.sql").read_text(encoding="utf-8")
SQL_0087 = (MIGRATIONS / "0087_audit_and_rate_hardening.sql").read_text(encoding="utf-8")


def function_body(text: str, name: str) -> str:
    m = re.search(rf"create or replace function public\.{name}\(.*?\n\$\$;", text, re.S)
    assert m, f"{name} not found"
    return m.group(0)


def literals(sql: str) -> set:
    """Every SQL string literal (with '' as an escaped quote), comments ignored."""
    return {m.group(1) for m in re.finditer(r"'((?:[^']|'')*)'", re.sub(r"--[^\n]*", "", sql)) if len(m.group(1)) >= 3}


def squash(sql: str) -> str:
    """Comments and whitespace out, so a pin is about the statements."""
    sql = re.sub(r"--[^\n]*", "", sql)
    return re.sub(r"\s+", " ", sql).strip()


class ApiBeginIsTheLatestBodyPlusOneChange(unittest.TestCase):
    def test_only_the_unknown_key_branch_changed(self):
        old = function_body(SQL_0062, "api_begin")
        new = function_body(SQL, "api_begin")
        before = ("  if k.id is null or k.revoked_at is not null then\n"
                  "    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');\n"
                  "  end if;\n")
        after = ("  if k.id is null then\n    return public.oauth_ctx(p_key_hash, p_endpoint, p_request_id);\n  end if;\n"
                 "  if k.revoked_at is not null then\n"
                 "    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');\n"
                 "  end if;\n")
        self.assertEqual(old.count(before), 1, "0062's api_begin changed: rebuild 0093 on the latest body")
        self.assertEqual(squash(old.replace(before, after)), squash(new))

    def test_no_later_migration_replaces_api_begin_after_0062(self):
        later = [p.name for p in sorted(MIGRATIONS.glob("*.sql"))
                 if p.name[:4] > "0062" and p.name != "0093_mcp_oauth.sql"
                 and "create or replace function public.api_begin" in p.read_text(encoding="utf-8")]
        self.assertEqual(later, [], "0093 is built on 0062's api_begin; a newer one must be merged in")

    def test_every_literal_of_the_old_body_is_still_there(self):
        old = function_body(SQL_0062, "api_begin")
        new = function_body(SQL, "api_begin")
        for lit in literals(old):
            self.assertIn(lit, literals(new), f"api_begin lost the literal {lit!r}")


class AuditActions(unittest.TestCase):
    def test_the_list_is_0087_plus_four(self):
        def actions(text):
            block = re.search(r"coalesce\(p_action, ''\) = any \(array\[(.*?)\]::text\[\]\)", function_body(text, "audit_action_allowed"), re.S).group(1)
            return set(re.findall(r"'([a-z_.]+)'", block))

        self.assertEqual(actions(SQL) - actions(SQL_0087), {"mcp.connect", "mcp.disconnect", "mcp.disconnect_all", "mcp.limit"})
        self.assertEqual(actions(SQL_0087) - actions(SQL), set())
        for pattern in (r"'^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'", r"'^learning\.(approve|reject)$'"):
            self.assertIn(pattern, function_body(SQL, "audit_action_allowed"))

    def test_the_actions_the_functions_write_are_listed(self):
        written = set(re.findall(r"'(mcp\.[a-z_]+)'", re.sub(r"--[^\n]*", "", SQL)))
        listed = set(re.findall(r"'(mcp\.[a-z_]+)'", function_body(SQL, "audit_action_allowed")))
        self.assertEqual(written, listed)


class TokensNeverReachTheUsdBalance(unittest.TestCase):
    def test_the_allow_list_is_exactly_the_credit_and_read_surface(self):
        body = function_body(SQL, "oauth_endpoint_scope")
        endpoints = set(re.findall(r"when '([a-z.]+)' then", body))
        self.assertEqual(endpoints, {"oauth.check", "channels.list", "accounts.list", "videos.list", "videos.get",
                                     "oauth.jobs.get", "oauth.balance", "oauth.videos.create", "videos.publish"})
        for forbidden in ("videos.create", "downloads.create", "downloads.get", "balance", "me", "jobs.get", "creative"):
            self.assertNotIn(f"'{forbidden}", body)
        self.assertNotIn("else", squash(body).replace("case p_endpoint", ""), "an unlisted endpoint must be refused, never defaulted")

    def test_functions_a_token_reaches_name_no_usd_table(self):
        usd = ("api_accounts", "api_holds", "api_ledger", "api_prices", "api_account_lock", "api_hold", "api_month_spend", "balance_cents", "reserved_cents")
        for name in ("oauth_ctx", "oauth_create_video", "oauth_get_job", "oauth_get_balance", "oauth_check", "oauth_token_state",
                     "oauth_grant_month_credits"):
            body = re.sub(r"--[^\n]*", "", function_body(SQL, name))
            for word in usd:
                self.assertNotIn(word, body, f"{name} mentions {word}")

    def test_create_video_pays_with_site_credits_through_the_apps_own_hold(self):
        body = function_body(SQL, "oauth_create_video")
        self.assertIn("public.reserve_credits(v_org, v_ref, v_price)", body)
        self.assertIn("public.credit_account_lock(v_org)", body)
        self.assertIn("insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref)", body)
        self.assertIn("'rj-oa-'", body)
        # The limit is checked AFTER the lock is taken and BEFORE the hold, in that order.
        self.assertLess(body.index("credit_account_lock"), body.index("oauth_grant_month_credits"))
        self.assertLess(body.index("oauth_grant_month_credits"), body.index("reserve_credits"))
        # An unpriced video is refused.
        self.assertIn("'pricing_unavailable'", body)
        # The price is the formula the render_jobs payment guard demands the hold cover.
        self.assertIn("greatest(coalesce(jm, 0), vm.credits_per_unit * (1 + vm.margin) * v_secs / 60)", body)
        self.assertIn("credits_round_up", body)

    def test_the_entitlement_is_checked_on_every_call_and_at_each_door(self):
        self.assertIn("has_entitlement_internal(v_org, 'mcp')", function_body(SQL, "oauth_ctx"))
        for name in ("oauth_begin_authorization", "oauth_decide_authorization", "oauth_exchange_code", "oauth_refresh", "oauth_check"):
            self.assertRegex(function_body(SQL, name), r"has_entitlement_internal\(", f"{name} does not check the plan")
        self.assertIn("has_entitlement_internal(g.org_id, 'mcp')", function_body(SQL, "oauth_my_grants"))


class Privileges(unittest.TestCase):
    FUNCS = re.findall(r"create or replace function public\.(oauth_\w+)\(([^)]*)\)", SQL)

    def test_every_security_definer_function_pins_its_search_path(self):
        for name in {n for n, _ in self.FUNCS}:
            body = function_body(SQL, name)
            if "security definer" in body.split("$$", 1)[0]:
                self.assertIn("set search_path = public, pg_temp", body.split("$$", 1)[0], name)

    def test_every_function_is_revoked_from_everyone_then_granted_explicitly(self):
        grants = {}
        for who, fn in re.findall(r"grant execute on function public\.(\w+)\(([^)]*)\) to (\w+);", SQL) and []:
            pass
        for fn, args, to in re.findall(r"grant execute on function public\.(\w+)\(([^)]*)\) to ([\w, ]+);", SQL):
            grants.setdefault(fn, set()).update(x.strip() for x in to.split(","))
        for name in {n for n, _ in self.FUNCS}:
            self.assertRegex(SQL, rf"revoke all on function public\.{name}\([^)]*\) from public, anon, authenticated, service_role;", name)
        anon = {"oauth_register_client", "oauth_exchange_code", "oauth_refresh", "oauth_revoke_token", "oauth_check",
                "oauth_create_video", "oauth_get_job", "oauth_get_balance"}
        signed_in = {"oauth_begin_authorization", "oauth_decide_authorization", "oauth_my_grants", "oauth_revoke_grant",
                     "oauth_revoke_all_grants", "oauth_set_grant_limit"}
        self.assertEqual({f for f, to in grants.items() if to == {"anon"}}, anon)
        self.assertEqual({f for f, to in grants.items() if to == {"authenticated"}}, signed_in)
        self.assertEqual(set(grants), anon | signed_in, "no other oauth function is callable by an API role")

    def test_every_table_has_rls_and_no_grant(self):
        tables = re.findall(r"create table if not exists public\.(oauth_\w+)", SQL)
        self.assertEqual(len(tables), 8)
        for t in tables:
            self.assertIn(f"alter table public.{t} enable row level security;", SQL)
            self.assertRegex(SQL, rf"revoke all on[^;]*public\.{t}\b[^;]*from public, anon, authenticated, service_role;")
        self.assertNotRegex(SQL, r"create policy[^;]*oauth_")
        self.assertNotRegex(SQL, r"grant (select|insert|update|delete|all)[^;]*public\.oauth_")

    def test_tokens_and_codes_are_stored_only_as_hashes(self):
        for col in ("code_hash", "token_hash", "secret_hash"):
            self.assertRegex(SQL, rf"{col}\s+text[^\n]*check \({col} ~ '\^\[0-9a-f\]\{{64\}}\$'\)")
        for bad in ("access_token", "refresh_token text", "plaintext", "code text", "token text"):
            self.assertNotIn(bad, re.sub(r"--[^\n]*", "", SQL))

    def test_limits_the_owner_asked_for(self):
        self.assertIn("'access_ttl_seconds', 3600", SQL)
        self.assertIn("'refresh_ttl_days', 30", SQL)
        self.assertIn("'absolute_days', 90", SQL)
        self.assertIn("'code_ttl_seconds', 60", SQL)
        self.assertRegex(SQL, r"expires_at\s+timestamptz not null default now\(\) \+ interval '60 seconds'")
        self.assertIn("'default_limit_credits', 500, 'max_limit_credits', 20000", SQL)


class NoRoleWordsInWhatACustomerSees(unittest.TestCase):
    def test_messages_have_no_role_vocabulary(self):
        # Only this file's own functions: the API-key door's messages (api_begin) are older and unchanged.
        mine = "\n".join(function_body(SQL, n) for n in ("oauth_ctx", "oauth_create_video", "oauth_get_job", "oauth_get_balance", "oauth_check"))
        messages = re.findall(r"api_err\(\d+, '[a-z_]+',\s*(?:format\()?'((?:[^']|'')*)'", mine)
        self.assertGreater(len(messages), 8)
        for m in messages:
            self.assertNotRegex(m, r"\b(owner|editor|viewer|admin)\b", m)


if __name__ == "__main__":
    unittest.main()
