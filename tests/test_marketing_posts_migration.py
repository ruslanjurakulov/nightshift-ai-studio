"""Migration 0108 (the brand-channel poster) ships DORMANT and ADDITIVE. These are the checks that need no database:
they read the file and fail if it ever touches an existing policy, grant, trigger or function, if a function loses its
pinned search_path, if the kill switch defaults to on, if an API role gains a privilege it must not have, or if the audit
list loses a name. The behaviour itself (the status machine, the cap, the kill switch, the claim race, the hash, the
rollback) is attacked in tests/security/test_sec_marketing_posts.py.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SQL = (REPO / "supabase" / "migrations" / "0108_marketing_posts.sql").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
PREVIOUS = (REPO / "supabase" / "migrations" / "0107_owner_safety.sql").read_text(encoding="utf-8")

NEW_TABLES = {"marketing_settings", "marketing_posts", "showcase_assets"}
OWNER_FUNCTIONS = {"owner_marketing_get", "owner_marketing_edit", "owner_marketing_approve", "owner_marketing_reject",
                   "owner_marketing_kill"}
WORKER_FUNCTIONS = {"marketing_draft_upsert", "claim_marketing_post", "complete_marketing_post"}
INTERNAL_FUNCTIONS = {"marketing_texts_ok", "marketing_post_hash", "marketing_cap_used", "marketing_posts_guard",
                      "marketing_posts_no_delete", "marketing_settings_no_delete", "marketing_settings_stamp",
                      "marketing_settings_trail"}
NEW_FUNCTIONS = OWNER_FUNCTIONS | WORKER_FUNCTIONS | INTERNAL_FUNCTIONS
PERMITTED_REDEFINITION = {"audit_action_allowed"}
#: 0107's helpers: reused, never redefined here.
REUSED = {"owner_guard", "owner_audit", "owner_err", "admin_aal_ok", "take_web_rate", "security_event_log",
          "is_platform_admin", "default_org_id"}
NEW_ACTIONS = {"marketing.edit", "marketing.approve", "marketing.reject", "marketing.send", "marketing.fail",
               "marketing.kill", "showcase.mark", "showcase.revoke"}


def audit_list(text):
    block = re.search(r"create or replace function public\.audit_action_allowed.*?any \(array\[(.*?)\]::text\[\]\)", text, re.S).group(1)
    return set(re.findall(r"'([a-z_.]+)'", block))


def body(name):
    return re.search(rf"create or replace function public\.{name}\(.*?\n\$\$;", CODE, re.S).group(0)


class MarketingPostsMigration(unittest.TestCase):
    def test_the_only_existing_function_it_redefines_is_the_audit_list(self):
        defined = set(re.findall(r"create or replace function public\.(\w+)", CODE))
        self.assertEqual(defined, NEW_FUNCTIONS | PERMITTED_REDEFINITION)
        self.assertEqual(defined & REUSED, set())

    def test_it_creates_only_its_own_tables_and_touches_no_other(self):
        self.assertEqual(set(re.findall(r"create table if not exists public\.(\w+)", CODE)), NEW_TABLES)
        self.assertEqual(set(re.findall(r"alter table public\.(\w+)", CODE)), NEW_TABLES)
        for stmt in (m.group(0) for m in re.finditer(r"^(?:update|delete|truncate|drop|alter|insert|create|grant|revoke|comment|do)\b[^;]*", CODE, re.M)):
            if re.match(r"drop (trigger|policy) if exists", stmt):
                self.assertRegex(stmt, r"on public\.(marketing_settings|marketing_posts|showcase_assets)\b", stmt)
            elif re.match(r"alter table public\.(\w+) drop constraint if exists", stmt):
                self.assertIn(re.match(r"alter table public\.(\w+)", stmt).group(1), NEW_TABLES, stmt)
            elif re.match(r"drop (function|table|index)|update|delete|truncate", stmt):
                self.fail(f"a top-level statement removes or rewrites something: {stmt[:80]}")
        self.assertIsNone(re.search(r"drop table|drop function|alter function|drop column|alter table [^;]* rename", CODE, re.I))
        # the references to other tables are foreign keys and reads, never writes
        self.assertEqual(re.findall(r"references public\.(\w+)", CODE), ["organizations"])

    def test_no_trigger_goes_on_an_existing_table(self):
        triggers = re.findall(r"create trigger (\w+)\s+(?:before|after) [a-z ]+? on public\.(\w+)", CODE)
        self.assertEqual({t for _, t in triggers}, {"marketing_posts", "marketing_settings"})
        self.assertEqual(len(triggers), 7)

    def test_the_only_policy_it_creates_is_the_admin_read_of_the_posts(self):
        policies = re.findall(r"(create|drop|alter) policy (?:if exists )?(\w+) on public\.(\w+)", CODE)
        self.assertEqual({(p[1], p[2]) for p in policies}, {("marketing_posts_select_admin", "marketing_posts")})
        self.assertIn("for select to authenticated using ((select public.is_platform_admin()))", CODE)

    def test_every_table_has_row_level_security_and_no_api_role_keeps_a_default_grant(self):
        for table in NEW_TABLES:
            self.assertIn(f"alter table public.{table} enable row level security;", CODE)
            self.assertIn(f"revoke all on public.{table} from public, anon, authenticated, service_role;", CODE)

    def test_grants_name_only_new_objects_and_the_api_roles_get_only_what_is_meant(self):
        grants = re.findall(r"^grant\s+(.*?)\s+on\s+(function|table)?\s*public\.(\w+)(\([^)]*\))?\s+to\s+([a-z_, ]+);", CODE, re.M | re.S)
        got = {(g[0], g[2], g[4].strip()) for g in grants}
        want = {("select", "marketing_posts", "authenticated")}
        want |= {("execute", f, "authenticated") for f in OWNER_FUNCTIONS}
        want |= {("execute", f, "service_role") for f in WORKER_FUNCTIONS}
        self.assertEqual(got, want)
        for m in re.finditer(r"^grant\s.*?;", CODE, re.M | re.S):
            self.assertNotRegex(m.group(0), r"\banon\b|\bpublic\b\s*[;,]|\bto\s+public\b", m.group(0))
        for m in re.finditer(r"^(?:grant|revoke)\s+(?:execute|all|select).*?on\s+(?:function\s+)?public\.(\w+)", CODE, re.M | re.S):
            self.assertTrue(m.group(1) in NEW_TABLES | NEW_FUNCTIONS | PERMITTED_REDEFINITION, m.group(0)[:80])

    def test_every_function_pins_its_search_path_with_pg_temp_last(self):
        for name in sorted(NEW_FUNCTIONS | PERMITTED_REDEFINITION):
            self.assertIn("set search_path = public, pg_temp", body(name).split("$$")[0], name)
        definers = set(re.findall(r"create or replace function public\.(\w+)\([^$]*?security definer", CODE, re.S))
        self.assertEqual(definers, NEW_FUNCTIONS - {"marketing_texts_ok", "marketing_post_hash"})

    def test_nothing_is_switched_on_by_default(self):
        self.assertRegex(CODE, r"enabled\s+boolean not null default false")
        self.assertRegex(CODE, r"max_per_7d\s+integer not null default 2")
        self.assertRegex(CODE, r"check \(max_per_7d between 0 and 2\)")
        self.assertRegex(CODE, r"facts_max_age_hours\s+integer not null default 24")
        self.assertRegex(CODE, r"approval_ttl_hours\s+integer not null default 72")
        self.assertRegex(CODE, r"check \(approval_ttl_hours between 1 and 72\)")
        self.assertRegex(CODE, r"insert into public\.marketing_settings \(id\) values \(true\) on conflict \(id\) do nothing")
        # no top-level statement flips the switch (only owner_marketing_kill does, inside its function)
        self.assertNotRegex(CODE, r"(?m)^update public\.marketing_settings")
        self.assertRegex(CODE, r"(?m)^set local lock_timeout = '5s';")
        self.assertNotRegex(CODE, r"(?m)^set (?!local)")

    def test_the_target_is_a_column_and_only_telegram_exists(self):
        self.assertRegex(CODE, r"target\s+text not null default 'telegram'")
        self.assertIn("check (target in ('telegram'))", CODE)

    def test_the_status_machine_lists_exactly_the_legal_moves(self):
        guard = body("marketing_posts_guard")
        for move in ("old.status = 'draft' and new.status in ('approved', 'rejected', 'expired')",
                     "old.status = 'approved' and new.status in ('sending', 'expired', 'draft')",
                     "old.status = 'sending' and new.status in ('sent', 'failed', 'dead', 'approved')"):
            self.assertIn(move, guard)
        self.assertIn("old.status in ('sent', 'failed', 'dead', 'rejected', 'expired')", guard)
        self.assertIn("approved_hash is distinct from new.content_hash", guard)
        self.assertRegex(CODE, r"check \(status in \('draft', 'approved', 'sending', 'sent', 'failed', 'dead', 'rejected', 'expired'\)\)")
        self.assertIn("check (kind in ('news', 'showcase', 'price'))", CODE)
        self.assertRegex(CODE, r"create unique index if not exists marketing_posts_idempotency_key on public\.marketing_posts \(idempotency_key\)")

    def test_every_owner_function_checks_the_caller_first(self):
        self.assertIn("auth.uid() is null or not public.is_platform_admin()", body("owner_marketing_get"))
        self.assertIn("errcode = '42501'", body("owner_marketing_get"))
        for fn in sorted(OWNER_FUNCTIONS - {"owner_marketing_get"}):
            self.assertRegex(body(fn), r"g := public\.owner_guard\('marketing_\w+', \d+\);\s+if g is not null then return g; end if;", fn)
            self.assertIn("public.owner_audit('marketing.", body(fn), fn)

    def test_the_worker_functions_do_not_trust_a_caller_identity(self):
        for fn in sorted(WORKER_FUNCTIONS):
            self.assertNotIn("auth.uid()", body(fn), fn)   # service_role only: no person behind the call
        self.assertIn("pg_advisory_xact_lock", body("claim_marketing_post"))
        self.assertIn("pg_advisory_xact_lock", body("owner_marketing_approve"))
        claim = body("claim_marketing_post")
        self.assertLess(claim.index("pg_advisory_xact_lock"), claim.index("marketing_cap_used()"))
        self.assertIn("x.approved_hash = public.marketing_post_hash(", claim)
        self.assertIn("interval '72 hours'", claim)

    def test_the_audit_list_is_0107s_plus_exactly_eight_names(self):
        old, new = audit_list(PREVIOUS), audit_list(SQL)
        self.assertTrue(old <= new, sorted(old - new))
        self.assertEqual(new - old, NEW_ACTIONS)
        self.assertGreaterEqual(len(old), 70)
        # the regex families are kept
        self.assertIn(r"'^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'", SQL)
        self.assertIn(r"'^learning\.(approve|reject)$'", SQL)

    def test_every_action_the_functions_audit_is_in_the_list(self):
        written = set(re.findall(r"owner_audit\('([a-z_.]+)'", CODE))
        self.assertEqual(written, {a for a in NEW_ACTIONS if a.startswith("marketing.")})
        self.assertTrue(written <= audit_list(SQL))

    def test_the_guards_name_only_what_0107_and_0018_made(self):
        for needle in ("to_regprocedure('public.owner_guard(text, integer)') is null",
                       "to_regprocedure('public.owner_audit(text, text, jsonb, text)') is null",
                       "to_regprocedure('public.owner_err(text, text, jsonb)') is null",
                       "to_regprocedure('public.admin_aal_ok()') is null",
                       "to_regprocedure('public.default_org_id()') is null"):
            self.assertIn(needle, CODE)

    def test_the_review_fixes_are_in_the_file(self):
        # approving needs the poster on, so an approval cannot lapse unsent and use up the key
        approve = body("owner_marketing_approve")
        self.assertIn("owner_err('poster_off'", approve)
        self.assertLess(approve.index("'expired'"), approve.index("'already', true"))   # a lapsed approval is not "already approved"
        # the worker never overwrites what a person edited
        self.assertIn("p.status = 'draft' and p.edited_at is null", body("marketing_draft_upsert"))
        # everything the sender puts in the message is in the hash
        self.assertIn("coalesce(p_link, '')", body("marketing_post_hash"))
        self.assertIn("new.media_path, new.link", body("marketing_posts_guard"))
        self.assertIn("x.media_path, x.link", body("claim_marketing_post"))
        self.assertIn("check (kind <> 'showcase' or media_path is not null)", CODE)
        # invisible and direction-changing characters
        for needle in (r"\u200b-\u200f", r"\u2028-\u202e", r"\u2066-\u2069", r"\ufeff", r"\x7f-\x9f"):
            self.assertIn(needle, body("marketing_texts_ok"))
        # every statement that rewrites the settings row names it (safe for pg_safeupdate)
        for stmt in re.findall(r"update public\.marketing_settings[^;]*;", CODE):
            self.assertRegex(stmt, r"where id;$", stmt)

    def test_the_text_limits_are_the_documented_ones(self):
        fn = body("marketing_texts_ok")
        self.assertIn("not between 1 and 1000", fn)
        self.assertIn("+ 160", fn)
        self.assertIn("then 1024 else 4096", fn)

    def test_the_rollback_file_exists_and_restores_the_old_audit_list(self):
        rollback = (REPO / "docs" / "sql" / "rollback_0108_marketing_posts.sql").read_text(encoding="utf-8")
        self.assertEqual(audit_list(rollback), audit_list(PREVIOUS))
        for table in NEW_TABLES:
            self.assertIn(f"drop table if exists public.{table};", rollback)
        for fn in NEW_FUNCTIONS:
            self.assertRegex(rollback, rf"drop function if exists public\.{fn}\(")
        self.assertRegex(rollback, r"(?m)^begin;$")
        self.assertRegex(rollback, r"(?m)^commit;$")

    def test_nothing_in_the_application_uses_it_yet(self):
        names = re.compile(r"marketing_posts|marketing_settings|showcase_assets|owner_marketing_|claim_marketing_post|"
                           r"complete_marketing_post|marketing_draft_upsert")
        skip = {"node_modules", ".next", "__pycache__"}
        offenders = []
        for root in ("command-center/app", "command-center/lib", "command-center/components", "modules", "tools", "supabase/functions", ".github"):
            base = REPO / root
            if not base.exists():
                continue
            for p in base.rglob("*"):
                if p.is_file() and not skip & set(p.parts) and p.suffix in (".ts", ".tsx", ".py", ".js", ".yml", ".yaml", ".sql"):
                    if names.search(p.read_text(encoding="utf-8", errors="ignore")):
                        offenders.append(str(p.relative_to(REPO)))
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
