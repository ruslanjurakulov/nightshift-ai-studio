"""supabase/migrations/0085_public_video_rates.sql — the public price of a
video in credits, for the signed-out price pages.

SQL runs in tests/security (test_sec_public_video_rates.py, a real Postgres);
this pins, without a database, what must not change by accident: the function
names exactly two units, returns no base rate, margin or note (BR-G-001: the
base next to the charged rate is the margin by division), is a definer read,
and is granted revoke-then-grant to anon and authenticated only.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0085_public_video_rates.sql").read_text()
CODE = re.sub(r"--[^\n]*", "", SQL)


class PublicVideoRates(unittest.TestCase):
    def test_names_only_the_minute_and_the_floor(self):
        self.assertIn("where cp.unit in ('video_minute', 'job_minimum')", CODE)

    def test_returns_the_rate_as_charged_and_nothing_of_the_operator(self):
        self.assertIn("returns table (unit text, credits_per_unit numeric)", CODE)
        start = CODE.index("as $$")
        body = CODE[start:CODE.index("$$;", start)]
        self.assertNotRegex(body, r"\bnote\b|cp\.margin\s+as|,\s*cp\.margin\b|updated_at")
        self.assertIn("cp.credits_per_unit * (1 + cp.margin)", body)

    def test_is_a_definer_read_granted_to_anon_and_members_only(self):
        self.assertIn("language sql stable security definer set search_path = public, pg_temp", CODE)
        self.assertIn(
            "revoke all on function public.public_video_rates() from public, anon, authenticated, service_role;\n"
            "grant execute on function public.public_video_rates() to anon, authenticated;",
            CODE,
        )

    def test_is_additive(self):
        self.assertNotRegex(CODE.lower(), r"\bdrop\b|\balter table\b|\bdelete\b|\bupdate\b")


if __name__ == "__main__":
    unittest.main()
