"""supabase/migrations/0151_model_probe_seconds.sql — the Studio's progress seed from the platform's own probe of a model.

SQL does not run in this suite (tests/security/test_sec_model_probe_seconds.py does that, against a real Postgres); these pin what
must never change by accident: one stable SECURITY DEFINER function with a pinned search_path and nothing else; signed-in sessions
only (not anon, not the service role); sign-in and the input bound checked before anything is read; only successful probes of what
the registry calls today, and only models on sale unless the caller is a platform admin; no column that carries a probe's error
text, bytes, prober or vendor model; the md5 in the drift guard, the end state and the rollback is the body's own.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0151_model_probe_seconds.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0151_model_probe_seconds.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
SIG = "public.model_probe_seconds(text[])"


def definition() -> str:
    m = re.search(r"^create or replace function public\.model_probe_seconds\(.*?^\$\$;$", SQL, re.S | re.M)
    assert m
    return m.group(0)


def body() -> str:
    return definition().split("as $$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5() -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", body()).encode()).hexdigest()


class ModelProbeSecondsMigration(unittest.TestCase):
    def test_one_function_and_nothing_else(self):
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", CODE), ["model_probe_seconds"])
        self.assertNotRegex(CODE, r"create table|alter table|create (unique )?index|drop |create (or replace )?view|create policy|create trigger")

    def test_a_stable_definer_with_a_pinned_search_path(self):
        head = definition().split("as $$", 1)[0]
        self.assertIn("language plpgsql stable security definer set search_path = public, pg_temp", head)

    def test_read_only(self):
        low = body().lower()
        for verb in ("insert into", "update public", "delete from", "truncate", "perform ", "credits", "set_config", "creative_jobs"):
            self.assertNotIn(verb, low, verb)

    def test_signed_in_and_the_bounds_are_checked_before_anything_is_read(self):
        inside = body().split("\nbegin\n", 1)[1]
        signed_in = inside.index("if auth.uid() is null then\n    raise exception 'not available' using errcode = '42501';")
        bound = inside.index("cardinality(p_models) > 50")
        shape = inside.index("!~ '^[a-z0-9][a-z0-9.-]{1,39}$'")
        reads = inside.index("public.model_registry")
        self.assertLess(signed_in, bound)
        self.assertLess(bound, reads)
        self.assertLess(shape, reads)
        self.assertIn("array_ndims(p_models) <> 1", inside)
        self.assertIn("m.id is null", inside)
        self.assertIn("raise exception 'invalid models' using errcode = '22023';", inside)

    def test_the_id_shape_is_the_registrys_own(self):
        m35 = (MIG / "0035_model_registry.sql").read_text(encoding="utf-8")
        self.assertIn("check (id ~ '^[a-z0-9][a-z0-9.-]{1,39}$')", m35)

    def test_only_successful_probes_of_what_the_registry_calls_today(self):
        b = body()
        self.assertIn("and p.ok\n", b)
        self.assertIn("and p.latency_ms > 0", b)
        self.assertIn("and p.adapter = r.adapter", b)
        self.assertIn("and p.vendor_model = coalesce(r.spec -> 'vendor_model_by_capability' ->> p.capability, r.spec ->> 'vendor_model')", b)
        # The newest success PER CAPABILITY: an i2v job keeps its seed when the newest probe of the model was a t2v one.
        self.assertIn("select distinct on (p.capability) p.id, p.capability, p.latency_ms, p.created_at", b)
        self.assertIn("order by p.capability, p.created_at desc, p.id desc) pr", b)
        self.assertNotIn("limit 1", b)

    def test_a_failure_after_the_success_is_reported_for_the_same_capability(self):
        b = body()
        self.assertIn("and f.capability = pr.capability\n                      and not f.ok\n                      and (f.created_at, f.id) > (pr.created_at, pr.id)", b)

    def test_only_models_on_sale_unless_the_caller_is_a_platform_admin(self):
        self.assertIn("and ((r.availability in ('beta', 'ga') and r.verified_at is not null and public.model_is_available(r.id))\n"
                      "            or public.is_platform_admin());", body())

    def test_a_customer_sees_exactly_what_0124s_registry_policy_shows_the_owners_switch_included(self):
        # 0124 replaced model_registry_select with this rule; a copy of 0035's older one would show a switched-off model.
        m124 = next(MIG.glob("0124_*.sql")).read_text(encoding="utf-8")
        self.assertIn("public.model_is_available(id)", m124.split("model_registry_select", 2)[-1])
        self.assertIn("if to_regprocedure('public.model_is_available(text)') is null then\n    raise exception '0151 needs 0124", CODE)

    def test_the_clip_length_comes_only_from_a_probe_block_of_the_same_capability(self):
        b = body()
        self.assertIn("case when r.spec -> 'probe' ->> 'capability' = pr.capability", b)
        self.assertIn("and jsonb_typeof(r.spec -> 'probe' -> 'duration_s') = 'number'", b)

    def test_no_column_carries_error_text_bytes_the_prober_or_the_vendor_model(self):
        head = definition().split("language plpgsql", 1)[0]
        cols = re.findall(r"^\s+(\w+)\s+(?:text|numeric|timestamptz|boolean),?$", head, re.M)
        self.assertEqual(cols, ["model_id", "capability", "probe_seconds", "clip_seconds", "probed_at", "failed_after"])
        returned = body().split("return query", 1)[1].split("from public.model_registry r", 1)[0]
        for word in ("error", "output_bytes", "probed_by", "vendor_model", "adapter", "pricing"):
            self.assertNotIn(word, returned, word)

    def test_execute_is_closed_then_opened_to_signed_in_sessions_only(self):
        self.assertIn(f"revoke all on function {SIG} from public, anon, authenticated, service_role;", CODE)
        self.assertEqual(re.findall(rf"grant execute on function {re.escape(SIG)} to ([a-z_, ]+);", CODE), ["authenticated"])

    def test_the_drift_guard_the_end_state_and_the_rollback_name_the_bodys_own_md5(self):
        h = pg_md5()
        self.assertEqual(SQL.count(f"'{h}'"), 2, "the drift guard and the end state")
        self.assertIn(f"'{h}'", ROLLBACK)
        self.assertEqual(len(set(re.findall(r"'([0-9a-f]{32})'", SQL))), 1)

    def test_the_end_state_checks_grants_definer_and_search_path(self):
        end = SQL.split("-- 2. End state", 1)[1]
        for needle in ("has_function_privilege('authenticated', fn, 'EXECUTE')", "has_function_privilege('anon', fn, 'EXECUTE')",
                       "has_function_privilege('service_role', fn, 'EXECUTE')", "not p.prosecdef", "p.provolatile <> 's'",
                       "a.grantee = 0", "'search_path=public, pg_temp'"):
            self.assertIn(needle, end, needle)

    def test_the_file_says_how_to_apply_it_and_what_to_verify(self):
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "LIVE ON APPLY", "it INCLUDES the download",
                       "reveals NO organization's data"):
            self.assertIn(needle, SQL, needle)
        self.assertIn("set local lock_timeout", CODE)

    def test_the_rollback_is_one_transaction_that_only_drops_this_function(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        code = "\n".join(line.split("--", 1)[0] for line in ROLLBACK.splitlines())
        self.assertEqual(re.findall(r"drop function if exists ([^;]+);", code), [SIG])
        self.assertNotRegex(code, r"create |alter |grant |revoke ")

    def test_the_number_is_unique_and_documented(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0151"), 1)
        # 0148 and 0150 are reserved by other work, 0147 and 0149 are open pull requests: none of them may be this file.
        for taken in ("0147", "0148", "0149", "0150"):
            for p in MIG.glob(f"{taken}_*.sql"):
                self.assertNotIn("model_probe_seconds", p.read_text(encoding="utf-8"), p.name)
        self.assertIn("## The Studio's progress seed from a probe (0151)", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()
