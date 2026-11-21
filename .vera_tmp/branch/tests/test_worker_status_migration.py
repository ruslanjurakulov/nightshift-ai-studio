"""supabase/migrations/0045_worker_status.sql — worker status, the database half.

SQL does not run in this suite, so these pin what matters (the security lab,
tests/security/test_sec_worker_status.py, runs the attacks against a real
Postgres 16): the table is operator-read only and nobody writes it directly;
reports come only from the service role and are clamped to 300 characters;
the one customer-facing function is signed-in only, pinned, and returns
nothing but a state and an age."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0045_worker_status.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())


def fn_body(name):
    return CODE.split(f"function public.{name}(", 1)[1].split("$$;", 1)[0]


def grants(name):
    return [r.strip() for m in re.finditer(rf"grant execute on function public\.{name}\([^)]*\) to ([a-z_, ]+);", CODE)
            for r in m.group(1).split(",")]


class WorkerStatusMigration(unittest.TestCase):
    def test_is_additive_and_idempotent(self):
        self.assertIn("create table if not exists public.worker_status", CODE)
        self.assertIn("create index if not exists", CODE)
        self.assertEqual(len(re.findall(r"create or replace function", CODE)), 2)
        self.assertNotRegex(CODE, r"\bdrop (table|column|function)\b")
        self.assertNotRegex(CODE, r"\balter table public\.(?!worker_status\b)")
        self.assertIn("drop policy if exists worker_status_select", CODE)

    def test_needs_only_the_organization_and_credit_helpers(self):
        self.assertIn("is_platform_admin()", CODE.split("create table", 1)[0])
        self.assertIn("credits_trusted_caller()", CODE.split("create table", 1)[0])
        self.assertNotRegex(CODE, r"public\.(media_uploads|media_assets|org_members)")

    def test_columns_and_checks(self):
        t = CODE.split("create table if not exists public.worker_status", 1)[1].split(");", 1)[0]
        self.assertIn("worker_id   text primary key", t)
        self.assertIn("check (kind in ('media', 'creative', 'pipeline', 'other'))", t)
        self.assertIn("check (state in ('starting', 'running', 'failed', 'stopped'))", t)
        self.assertIn("char_length(detail) <= 300", t)
        for col in ("version", "started_at", "updated_at"):
            self.assertIn(col, t)

    def test_rls_on_operator_reads_nobody_writes(self):
        self.assertIn("alter table public.worker_status enable row level security;", CODE)
        self.assertIn("revoke all on public.worker_status from public, anon, authenticated, service_role;", CODE)
        self.assertIn("grant select on public.worker_status to authenticated, service_role;", CODE)
        self.assertEqual(re.findall(r"create policy \w+ on public\.worker_status\s+for (\w+)", CODE), ["select"])
        self.assertRegex(CODE, r"create policy worker_status_select on public\.worker_status\s+for select to authenticated\s+"
                               r"using \(\(select public\.is_platform_admin\(\)\)\);")
        self.assertNotRegex(CODE, r"grant [^;]*\b(insert|update|delete)\b[^;]* to ")
        self.assertNotRegex(CODE, r"\bto anon\b")
        self.assertNotRegex(CODE, r"to authenticated, anon|to anon, authenticated")

    def test_report_is_service_only_and_clamps(self):
        body = fn_body("report_worker_status")
        self.assertIn("security definer set search_path = public, pg_temp", CODE.split("function public.report_worker_status(", 1)[1].split("$$", 1)[0])
        self.assertIn("if not public.credits_trusted_caller() then", body)
        self.assertIn("errcode = '42501'", body)
        self.assertIn("left(", body)
        self.assertIn(", 300)", body)  # detail is cut to 300
        self.assertIn("[[:cntrl:]]", body)
        self.assertEqual(grants("report_worker_status"), ["service_role"])
        self.assertIn("revoke all on function public.report_worker_status(text, text, text, text, text) "
                      "from public, anon, authenticated, service_role;", CODE)

    def test_customer_function_is_pinned_signed_in_only_and_returns_no_detail(self):
        head = CODE.split("function public.media_pipeline_state(", 1)[1].split("$$", 1)[0]
        self.assertIn("security definer set search_path = public, pg_temp", head)
        self.assertEqual(grants("media_pipeline_state"), ["authenticated"])
        body = fn_body("media_pipeline_state")
        self.assertIn("120 seconds", body)
        for verdict in ("'ok'", "'stale'", "'failed'", "'unknown'"):
            self.assertIn(verdict, body)
        # Only state and age leave the function: never detail, worker ids or versions.
        self.assertEqual(re.findall(r"jsonb_build_object\(([^)]*)\)", body),
                         ["'state', 'unknown', 'age_seconds', null", "'state', verdict, 'age_seconds', age"])
        for col in ("detail", "version", "worker_id", "org"):
            self.assertNotIn(col, body.replace("kind = 'media'", ""))

    def test_media_state_looks_at_media_workers_only(self):
        body = fn_body("media_pipeline_state")
        self.assertEqual(len(re.findall(r"from public\.worker_status", body)), 3)
        self.assertEqual(len(re.findall(r"kind = 'media'", body)), 3)


if __name__ == "__main__":
    unittest.main()
