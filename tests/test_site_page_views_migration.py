"""supabase/migrations/0101_site_page_views.sql — first-party, cookieless page counts.

The behaviour runs in tests/security/test_sec_page_views.py (a real Postgres).
This pins, without a database, what must not change by accident: one table of
daily totals with no column that could hold a person, closed to every API role
with no policy, one write function that anon may call and that pins its
search_path, a closed path list that equals the public pages, and nothing
dropped.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0101_site_page_views.sql").read_text()
CODE = re.sub(r"--[^\n]*", "", SQL)
PUBLIC_PATHS_TS = (ROOT / "command-center" / "lib" / "public-paths.ts").read_text()


def function_bodies():
    return re.findall(r"create or replace function public\.(\w+)\((.*?)\$\$;", CODE, re.S)


class SitePageViewsMigration(unittest.TestCase):
    def test_one_table_of_daily_totals_with_no_column_that_could_hold_a_person(self):
        self.assertEqual(re.findall(r"create table if not exists public\.(\w+)", CODE), ["site_page_views"])
        body = re.search(r"create table if not exists public\.site_page_views \((.*?)\n\);", CODE, re.S).group(1)
        cols = re.findall(r"^\s{2}(\w+)\s+(?:date|text|integer)", body, re.M)
        self.assertEqual(cols, ["day", "path", "ref_host", "device", "lang", "views"])
        self.assertIn("primary key (day, path, ref_host, device, lang)", body)
        for forbidden in ("ip", "user_agent", "ua", "visitor", "session", "cookie", "fingerprint", "created_at", "timestamp"):
            self.assertNotIn(forbidden, cols)

    def test_rls_on_no_policy_and_no_api_privilege(self):
        self.assertIn("alter table public.site_page_views enable row level security;", CODE)
        self.assertIn("revoke all on public.site_page_views from public, anon, authenticated;", CODE)
        self.assertNotRegex(CODE, r"create policy")
        self.assertNotRegex(CODE, r"grant \w+(?:, \w+)* on public\.site_page_views")

    def test_every_function_pins_its_search_path_and_the_grants_are_explicit(self):
        funcs = function_bodies()
        self.assertEqual(sorted(n for n, _ in funcs), ["record_page_view", "site_page_path_ok"])
        for name, body in funcs:
            self.assertRegex(body, r"set search_path = (public, pg_temp|pg_catalog, pg_temp)", name)
        record = dict(funcs)["record_page_view"]
        self.assertIn("security definer", record)
        granted = re.findall(r"grant execute on function public\.(\w+)\(.*?\) to ([a-z, ]+);", CODE)
        self.assertEqual(granted, [("record_page_view", "anon, authenticated")])
        self.assertIn("revoke all on function public.site_page_path_ok(text) from public, anon, authenticated, service_role;", CODE)
        self.assertIn("revoke all on function public.record_page_view(text, text, text, text) from public, service_role;", CODE)

    def test_the_function_has_the_ceiling_the_row_cap_and_never_raises_for_a_refusal(self):
        record = dict(function_bodies())["record_page_view"]
        self.assertIn("'pageview.anon@60'", record)
        self.assertIn("v_used > 600", record)
        self.assertIn(">= 3000", record)
        self.assertNotIn("raise exception", record)

    def test_the_closed_path_list_is_the_sitemap_list(self):
        sql_paths = re.findall(r"'(/[a-z/-]*)'", dict(function_bodies())["site_page_path_ok"])
        self.assertTrue(sql_paths)
        sitemap = re.search(r"export const SITEMAP_PATHS = \[(.*?)\] as const;", PUBLIC_PATHS_TS, re.S).group(1)
        # "/", STUDIO_PAGE_PATH, "/pricing", ...SOLUTION_PATHS, "/docs/api", "/mcp", "/privacy", "/terms"
        ts_literals = re.findall(r'"(/[a-z/-]*)"', sitemap)
        solutions = ["/solutions", "/solutions/youtube-channels", "/solutions/creative-studio", "/solutions/developers"]
        self.assertEqual(sorted(sql_paths), sorted(ts_literals + ["/studio"] + solutions))

    def test_it_needs_0087_and_drops_nothing(self):
        self.assertIn("0101 needs 0042/0087", CODE)
        self.assertNotRegex(CODE, r"\bdrop (table|function|policy|constraint)\b")
        self.assertNotRegex(CODE, r"\balter table public\.(?!site_page_views)")


if __name__ == "__main__":
    unittest.main()
