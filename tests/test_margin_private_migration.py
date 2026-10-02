"""supabase/migrations/0084_margin_private.sql — BR-G-001: the platform's
margin (credit_prices.margin) is never shown to an organization's members.

SQL does not run in this suite (tests/security does that, against a real
Postgres: test_sec_breach_margin_exposure.py); these pin what must not change
by accident:

* the two functions it replaces are built on the LATEST bodies — sellable_models
  on 0072's, quote_creative_job on 0036's — with every string literal kept and
  lines only added, except the ONE line of sellable_models that returned
  cp.margin;
* credit_prices is read by a platform owner/admin only (RLS by person), and
  credit_rates() hands members the rate as charged, never the margin or the
  note;
* the return type of sellable_models is unchanged (a replay of 0035..0072
  still applies), grants are revoke-then-grant, nothing is dropped.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "supabase" / "migrations"
SQL = (MIGRATIONS / "0084_margin_private.sql").read_text()


def bodies(text):
    return {m.group(1): m.group(0) for m in
            re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(sql):
    code = re.sub(r"--[^\n]*", "", sql)
    return set(re.findall(r"'(?:[^']|'')*'", code))


def code_lines(body):
    """The body's lines without comments or blank lines (comments may be added)."""
    out = []
    for line in body.splitlines():
        code = line.split("--", 1)[0].rstrip()
        if code.strip():
            out.append(code)
    return out


def latest_other(name):
    found = None
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if int(path.name[:4]) >= 84:
            continue
        b = bodies(path.read_text())
        if name in b:
            found = (path.name, b[name])
    if found is None:
        raise AssertionError(name)
    return found


NEW = bodies(SQL)
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())


class BuiltOnTheLatestBodies(unittest.TestCase):
    def test_it_replaces_exactly_these_functions(self):
        self.assertEqual(set(NEW), {"credit_rates", "sellable_models", "quote_creative_job"})

    def test_the_latest_other_bodies_are_0072s_and_0036s(self):
        self.assertEqual(latest_other("sellable_models")[0], "0072_captions.sql")
        self.assertEqual(latest_other("quote_creative_job")[0], "0036_creative_jobs.sql")

    def test_every_literal_of_the_latest_bodies_is_kept(self):
        for name in ("sellable_models", "quote_creative_job"):
            src, old = latest_other(name)
            for lit in literals(old):
                self.assertIn(lit, NEW[name], f"{name} lost {lit} from {src}")

    def test_sellable_models_changes_only_the_line_that_returned_the_margin(self):
        _, old = latest_other("sellable_models")
        before, after = code_lines(old), code_lines(NEW["sellable_models"])
        self.assertEqual(len(before), len(after))
        changed = [(a, b) for a, b in zip(before, after) if a != b]
        self.assertEqual(changed, [(
            "           m.credit_unit, m.entitlement, cp.credits_per_unit, cp.margin,",
            "           m.credit_unit, m.entitlement, cp.credits_per_unit * (1 + cp.margin), null::numeric,",
        )])
        # The return type is 0072's: replays of every earlier body still apply.
        self.assertIn("credits_per_unit numeric, margin numeric, spec jsonb)", NEW["sellable_models"])
        self.assertNotIn("cp.margin,", NEW["sellable_models"])

    def test_quote_creative_job_only_adds_lines(self):
        _, old = latest_other("quote_creative_job")
        before, after = code_lines(old), code_lines(NEW["quote_creative_job"])
        it = iter(after)
        self.assertTrue(all(line in it for line in before), "a line of 0036's quote_creative_job was changed or dropped")
        added = [line for line in after if line not in before]
        self.assertEqual([line.strip() for line in added], [
            "q := (q - 'margin') || jsonb_build_object('credits_per_unit',",
            "(q ->> 'credits_per_unit')::numeric * (1 + coalesce((q ->> 'margin')::numeric, 0)));",
        ])
        # Applied after the price is computed, before it is returned.
        body = NEW["quote_creative_job"]
        self.assertLess(body.index("q := public.creative_price("), body.index("q := (q - 'margin')"))
        self.assertLess(body.index("q := (q - 'margin')"), body.index("return q ||"))

    def test_captions_survive(self):
        # tests/test_captions.py: a later sellable_models must know captions.
        self.assertIn("'captions'", NEW["sellable_models"])
        self.assertIn("if p_capability = 'captions' and p_surface <> 'web' then", NEW["sellable_models"])

    def test_it_refuses_to_apply_on_an_older_catalog(self):
        self.assertIn("0084 needs 0072_captions.sql: apply it first", SQL)
        self.assertIn("position('captions' in pg_get_functiondef('public.sellable_models(text, text)'::regprocedure)) = 0", SQL)
        self.assertLess(SQL.index("0084 needs 0072_captions.sql"), SQL.index("create or replace function"))


class TheMarginStaysThePlatforms(unittest.TestCase):
    def test_the_price_list_is_read_by_a_platform_admin_only(self):
        self.assertIn(
            "drop policy if exists credit_prices_select on public.credit_prices;\n"
            "create policy credit_prices_select on public.credit_prices\n"
            "  for select to authenticated\n"
            "  using ((select public.is_platform_admin()));", CODE)
        # The 0020 write policies and column grants are not touched.
        for verb in ("insert", "update", "delete"):
            self.assertNotIn(f"policy credit_prices_{verb}", CODE)
        self.assertNotIn("grant insert", CODE)
        self.assertNotIn("grant update", CODE)

    def test_credit_rates_returns_the_rate_as_charged_never_margin_or_note(self):
        body = NEW["credit_rates"]
        head = body.split("as $$", 1)[0]
        self.assertIn("returns table (unit text, credits_per_unit numeric, updated_at timestamptz)", head)
        self.assertIn("security definer set search_path = public, pg_temp", head)
        self.assertIn("stable", head)
        sql = "\n".join(code_lines(body.split("as $$", 1)[1]))
        self.assertIn("when cp.unit in ('job_minimum', 'download_minimum') then cp.credits_per_unit", sql)
        self.assertIn("else cp.credits_per_unit * (1 + cp.margin) end", sql)
        self.assertIn("where (select auth.uid()) is not null", sql)
        self.assertNotIn("note", sql)
        # margin appears only inside the multiplication, never as an output column
        self.assertEqual(sql.count("margin"), 1)

    def test_grants_are_revoke_then_grant(self):
        self.assertIn("revoke all on function public.credit_rates() from public, anon, authenticated, service_role;\n"
                      "grant execute on function public.credit_rates() to authenticated;", CODE)
        self.assertIn("revoke all on function public.sellable_models(text, text) from public, anon;\n"
                      "grant execute on function public.sellable_models(text, text) to authenticated, service_role;", CODE)
        self.assertIn("revoke all on function public.quote_creative_job(uuid, text, text, jsonb) from public, anon, authenticated, service_role;\n"
                      "grant execute on function public.quote_creative_job(uuid, text, text, jsonb) to authenticated;", CODE)

    def test_additive(self):
        low = CODE.lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "alter table"):
            self.assertNotIn(word, low)
        self.assertIn("-- Verify", SQL)

    def test_no_later_migration_hands_the_margin_back(self):
        # A migration numbered after 0084 that replaces these must keep 0084's lines.
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if int(path.name[:4]) <= 84:
                continue
            b = bodies(path.read_text())
            if "sellable_models" in b:
                self.assertNotIn("cp.margin,", b["sellable_models"], path.name)
            if "quote_creative_job" in b:
                self.assertIn("(q - 'margin')", b["quote_creative_job"], path.name)
            if "credit_prices_select" in path.read_text():
                self.assertIn("is_platform_admin", path.read_text(), path.name)


if __name__ == "__main__":
    unittest.main()
