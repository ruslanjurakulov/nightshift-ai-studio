"""supabase/migrations/0064_notifications.sql — in-app notifications, the
database half.

SQL does not run in this suite, so these pin what matters; the security lab
(tests/security/test_sec_notifications.py) runs the attacks against a real
Postgres 16: an inbox is one person's own (cross-org and cross-user reads
refused), nobody writes it directly, rows come only from the four event
triggers, the two writes a browser may make touch only its own rows, and a
failed notification never rolls back the thing it reports."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILE = ROOT / "supabase" / "migrations" / "0064_notifications.sql"
SQL = FILE.read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

DEFINER = ("notification_emit", "notification_emit_org", "notify_creative_job_ended",
           "notify_storyboard_ready", "notify_editor_export_done", "notify_credits_low",
           "mark_notification_read", "mark_all_notifications_read")
BROWSER = ("mark_notification_read", "mark_all_notifications_read")


def head(name):
    return CODE.split(f"function public.{name}(", 1)[1].split("$$", 1)[0]


def body(name):
    return CODE.split(f"function public.{name}(", 1)[1].split("$$", 2)[1]


def grants(name):
    return [r.strip() for m in re.finditer(rf"grant execute on function public\.{name}\([^)]*\) to ([a-z_, ]+);", CODE)
            for r in m.group(1).split(",")]


class NotificationsMigration(unittest.TestCase):
    def test_number_is_the_allocated_one_and_unique(self):
        names = sorted(p.name for p in (ROOT / "supabase" / "migrations").glob("0064_*.sql"))
        self.assertEqual(names, ["0064_notifications.sql"])

    def test_is_additive_and_idempotent(self):
        self.assertIn("create table if not exists public.notifications", CODE)
        self.assertNotRegex(CODE, r"\bdrop (table|column|function)\b")
        self.assertNotRegex(CODE, r"\balter table public\.(?!notifications\b)")
        self.assertIn("drop policy if exists notifications_select", CODE)
        # No earlier function is replaced: only new names.
        created = re.findall(r"create or replace function public\.(\w+)\(", CODE)
        self.assertEqual(sorted(created), sorted(DEFINER + ("notification_low_credits_threshold",)))
        for t in ("creative_jobs", "storyboards", "editor_exports", "credit_accounts"):
            self.assertIn(f"drop trigger if exists {t}_notify on public.{t};", CODE)

    def test_every_function_is_pinned_and_security_definer_where_it_acts(self):
        for name in DEFINER:
            h = head(name)
            self.assertIn("security definer set search_path = public, pg_temp", h, name)
        self.assertIn("set search_path = public, pg_temp", head("notification_low_credits_threshold"))
        self.assertNotIn("security definer", head("notification_low_credits_threshold"))
        self.assertEqual(len(re.findall(r"security definer", CODE)), len(DEFINER))
        self.assertEqual(len(re.findall(r"set search_path = public, pg_temp", CODE)), len(DEFINER) + 1)

    def test_only_the_two_browser_functions_are_granted_and_only_to_signed_in_users(self):
        for name in BROWSER:
            self.assertEqual(grants(name), ["authenticated"], name)
        self.assertEqual(len(re.findall(r"grant execute on function", CODE)), len(BROWSER))
        for name in DEFINER + ("notification_low_credits_threshold",):
            self.assertRegex(CODE, rf"revoke all on function public\.{name}\([^)]*\) from public, anon, authenticated, service_role;", name)
        self.assertNotRegex(CODE, r"\bto anon\b")

    def test_rls_on_one_select_policy_for_the_person_it_is_for_and_no_writes(self):
        self.assertIn("alter table public.notifications enable row level security;", CODE)
        self.assertIn("revoke all on public.notifications from public, anon, authenticated, service_role;", CODE)
        self.assertIn("grant select on public.notifications to authenticated;", CODE)
        self.assertNotRegex(CODE, r"grant [^;]*\b(insert|update|delete|truncate)\b[^;]* to ")
        self.assertEqual(re.findall(r"create policy \w+ on public\.notifications\s+for (\w+)", CODE), ["select"])
        self.assertRegex(CODE, r"create policy notifications_select on public\.notifications\s+for select to authenticated\s+"
                               r"using \(user_id = auth\.uid\(\) and public\.is_org_member\(org_id\)\);")

    def test_kinds_and_data_are_bounded(self):
        t = CODE.split("create table if not exists public.notifications", 1)[1].split(");", 1)[0]
        self.assertIn("org_id     uuid not null references public.organizations (id) on delete cascade", t)
        self.assertIn("user_id    uuid not null references auth.users (id) on delete cascade", t)
        for kind in ("creative_job_completed", "creative_job_failed", "storyboard_ready", "editor_export_done", "credits_low"):
            self.assertIn(f"'{kind}'", CODE)
        self.assertIn("jsonb_typeof(data) = 'object' and pg_column_size(data) <= 2048", CODE)
        self.assertIn("create unique index if not exists notifications_user_kind_ref_key", CODE)

    def test_a_recipient_must_be_a_member_and_the_inbox_is_bounded(self):
        b = body("notification_emit")
        self.assertIn("from public.org_members m where m.org_id = p_org and m.user_id = p_user", b)
        self.assertIn("on conflict (user_id, kind, ref) do nothing", b)
        self.assertIn("interval '90 days'", b)
        self.assertIn("offset 200", b)

    def test_a_failed_notification_never_fails_the_event(self):
        for name in ("notify_creative_job_ended", "notify_storyboard_ready", "notify_editor_export_done", "notify_credits_low"):
            b = body(name)
            self.assertIn("exception when others then", b, name)
            self.assertIn("raise warning", b, name)

    def test_credits_returned_is_only_claimed_for_a_held_credit_job(self):
        b = body("notify_creative_job_ended")
        self.assertIn("jsonb_strip_nulls", b)
        self.assertIn("new.payer = 'credits' and new.credit_ref is not null", b)
        self.assertIn("new.kind = 'ingest'", b)
        self.assertIn("new.requested_by is null", b)
        self.assertNotIn("cancelled", b)

    def test_low_credits_is_a_crossing_once_a_day_and_never_for_the_exempt_org(self):
        b = body("notify_credits_low")
        self.assertIn("was >= line and now_ < line", b)
        self.assertIn("not public.credits_exempt(new.org_id)", b)
        self.assertIn("to_char(now() at time zone 'utc', 'YYYY-MM-DD')", b)

    def test_no_text_a_person_typed_is_copied_into_a_notification(self):
        for name in ("notify_creative_job_ended", "notify_storyboard_ready", "notify_editor_export_done", "notify_credits_low"):
            b = body(name)
            for field in ("params", "topic", "title", "error ", "email", "result"):
                self.assertNotRegex(b, rf"new\.{field.strip()}\b(?!_)", f"{name} copies {field}")

    def test_mark_read_touches_only_the_callers_rows_and_needs_a_session(self):
        for name in BROWSER:
            b = body(name)
            self.assertIn("auth.uid() is null", b)
            self.assertIn("errcode = '42501'", b)
            self.assertIn("user_id = auth.uid()", b)
            self.assertIn("read_at is null", b)

    def test_ends_with_a_verify_query(self):
        tail = SQL.split("-- Verify", 1)[1]
        self.assertTrue(all(line.startswith("--") or not line.strip() for line in tail.splitlines()[1:]))
        for needle in ("relrowsecurity", "has_table_privilege", "has_function_privilege", "search_path=%", "pg_policies"):
            self.assertIn(needle, tail)


if __name__ == "__main__":
    unittest.main()
