"""supabase/migrations/0101_retention_notify.sql, the text half (the security lab,
tests/security/test_sec_retention.py, runs it against Postgres 16).

Pins what must not drift: the one replaced function keeps every literal of the
0064 body it was built on, the old notification kinds all survive in the widened
check, every function pins its search_path, and the grants say who may call what
(the signed-out opt-out is the only thing anon may execute)."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0101_retention_notify.sql").read_text()
OLD = (ROOT / "supabase" / "migrations" / "0064_notifications.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
OLD_CODE = "\n".join(line.split("--", 1)[0] for line in OLD.splitlines())

DEFINER = ("notify_video_ready", "notify_storyboard_ready", "email_prefs_get", "email_prefs_set", "email_unsubscribe",
           "email_weekly_digest", "email_claim_ready", "email_claim_weekly", "email_complete")


def function_body(code, name):
    return code.split(f"function public.{name}(", 1)[1].split("$$", 2)[1]


def grants(name):
    return sorted({r.strip() for m in re.finditer(rf"grant execute on function public\.{name}\([^)]*\) to ([a-z_, ]+);", CODE)
                   for r in m.group(1).split(",")})


class RetentionMigration(unittest.TestCase):
    def test_the_number_is_unique(self):
        names = sorted(p.name for p in (ROOT / "supabase" / "migrations").glob("0101_*.sql"))
        self.assertEqual(names, ["0101_retention_notify.sql"])

    def test_it_is_additive(self):
        self.assertNotRegex(CODE, r"\bdrop (table|column|function)\b")
        self.assertNotRegex(CODE, r"\bdelete from public\.(?!email_deliveries\b)")
        self.assertIn("create table if not exists public.email_preferences", CODE)
        self.assertIn("create table if not exists public.email_deliveries", CODE)
        created = sorted(re.findall(r"create or replace function public\.(\w+)\(", CODE))
        self.assertEqual(created, sorted(DEFINER))
        self.assertIn("drop trigger if exists videos_notify_ready on public.videos;", CODE)

    def test_the_replaced_storyboard_function_keeps_every_literal_of_0064_and_adds_only_the_channel(self):
        old, new = function_body(OLD_CODE, "notify_storyboard_ready"), function_body(CODE, "notify_storyboard_ready")
        lits = lambda t: set(re.findall(r"'[^']*'", t))
        self.assertEqual(lits(new) - lits(old), {"'channel_id'"})
        self.assertFalse(lits(old) - lits(new), "an earlier literal was dropped")
        self.assertIn("exception when others then", new)
        self.assertIn("raise warning", new)
        head = lambda c: c.split("function public.notify_storyboard_ready(", 1)[1].split("$$", 1)[0]
        self.assertEqual(head(OLD_CODE), head(CODE))

    def test_the_kind_check_keeps_every_earlier_kind(self):
        old_kinds = set(re.findall(r"'(\w+)'", OLD_CODE.split("add constraint notifications_kind_check", 1)[1].split(";", 1)[0]))
        new_kinds = set(re.findall(r"'(\w+)'", CODE.split("add constraint notifications_kind_check", 1)[1].split(";", 1)[0]))
        self.assertTrue(old_kinds <= new_kinds)
        self.assertEqual(new_kinds - old_kinds, {"video_ready"})

    def test_every_function_pins_search_path_and_is_security_definer(self):
        for name in DEFINER:
            head = CODE.split(f"function public.{name}(", 1)[1].split("$$", 1)[0]
            self.assertIn("security definer set search_path = public, pg_temp", head, name)
        self.assertEqual(len(re.findall(r"security definer", CODE)), len(DEFINER))

    def test_every_function_is_revoked_from_everyone_then_granted_explicitly(self):
        for name in DEFINER:
            self.assertRegex(CODE, rf"revoke all on function public\.{name}\([^)]*\) from public, anon, authenticated, service_role;", name)
        self.assertEqual(grants("email_prefs_get"), ["authenticated"])
        self.assertEqual(grants("email_prefs_set"), ["authenticated"])
        self.assertEqual(grants("email_unsubscribe"), ["anon", "authenticated"])
        for name in ("email_claim_ready", "email_claim_weekly", "email_complete"):
            self.assertEqual(grants(name), ["service_role"], name)
        for name in ("notify_video_ready", "notify_storyboard_ready", "email_weekly_digest"):
            self.assertEqual(grants(name), [], name)
        self.assertEqual(len(re.findall(r"\bto anon\b", CODE)), 1, "only the opt-out is callable signed out")

    def test_the_tables_have_rls_on_no_policy_and_no_grant(self):
        for t in ("email_preferences", "email_deliveries"):
            self.assertIn(f"alter table public.{t} enable row level security;", CODE)
            self.assertIn(f"revoke all on public.{t} from public, anon, authenticated, service_role;", CODE)
        self.assertNotRegex(CODE, r"create policy")
        self.assertNotRegex(CODE, r"grant (select|insert|update|delete|all)[^;]* on public\.email")

    def test_weekly_is_opt_in_and_the_token_is_not_selectable(self):
        self.assertRegex(CODE, r"weekly_every_days smallint check \(weekly_every_days in \(7, 14\)\),")  # null by default
        self.assertNotRegex(CODE, r"weekly_every_days\s+smallint\s+not null")
        self.assertIn("ready_enabled     boolean not null default true", CODE)
        self.assertIn("unsubscribe_token ~ '^[0-9a-f]{64}$'", CODE)

    def test_language_is_a_code_not_an_allow_list(self):
        self.assertIn("check (locale ~ '^[a-z]{2,3}$')", CODE)
        self.assertNotRegex(CODE, r"in \('en', 'ru', 'uz'\)")

    def test_the_ready_mail_window_and_recheck_of_preferences_are_in_the_claim(self):
        body = function_body(CODE, "email_claim_ready")
        self.assertIn("interval '6 hours'", body)
        self.assertIn("not pref.ready_enabled", body)
        self.assertIn("email_confirmed_at", body)

    def test_a_verify_query_is_at_the_end(self):
        self.assertIn("-- Verify (run after applying; every column should read true)", SQL)


if __name__ == "__main__":
    unittest.main()
