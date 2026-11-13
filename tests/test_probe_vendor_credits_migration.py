"""supabase/migrations/0152_probe_vendor_credits.sql and tools/probe_models.py — a probe's vendor bill is kept with the probe.

What would break without these tests:
  * the figure Runway reports for a probe (``cost.credits``) living only in a workflow log, so the Billing page cannot count probes;
  * an eleven-argument ``record_model_probe`` with a DEFAULT on the new argument: every ten-argument call (the probe tool of the
    previous release, the security lab) would then be ambiguous and refused, and no probe could be recorded at all;
  * the new overload drifting from 0035's body (a probe that no longer verifies its model, or verifies the wrong one);
  * the tool losing a probe row because the database had not applied 0152 yet, or recording it twice on the fallback;
  * a reported figure being stored as 0 when the vendor said nothing (unknown is never 0).
"""

from __future__ import annotations

import io
import re
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
TEXT = (MIG / "0152_probe_vendor_credits.sql").read_text(encoding="utf-8")
M0035 = (MIG / "0035_model_registry.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0152_probe_vendor_credits.sql").read_text(encoding="utf-8")
ELEVEN = "text, text, text, text, boolean, text, text, integer, bigint, text, numeric"
TEN = "text, text, text, text, boolean, text, text, integer, bigint, text"


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def body(sql: str) -> str:
    m = re.search(r"create or replace function public\.record_model_probe\((.*?)\$\$(.*?)\$\$;", code(sql), re.S)
    assert m, "record_model_probe"
    return m.group(1) + m.group(2)


def squash(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


class Migration(unittest.TestCase):
    def test_the_column_is_nullable_with_no_default_and_a_bounded_rule(self):
        c = code(TEXT)
        self.assertIn("alter table public.model_probe_runs add column if not exists vendor_credits numeric;", c)
        self.assertNotRegex(c, r"vendor_credits numeric\s+(not null|default)")
        self.assertIn("check (vendor_credits is null or (vendor_credits >= 0 and vendor_credits <= 1000000))", squash(c))

    def test_the_new_argument_has_no_default_so_ten_argument_calls_stay_unambiguous(self):
        args = body(TEXT).split(")", 1)[0]
        self.assertIn("p_vendor_credits numeric", args)
        self.assertNotIn("default", args.lower())

    def test_the_overload_is_0035s_body_plus_the_one_column(self):
        new, old = squash(body(TEXT)), squash(body(M0035))
        self.assertEqual(
            new.replace(", p_vendor_credits numeric", "").replace(", vendor_credits)", ")").replace(", p_vendor_credits)", ")"),
            old)

    def test_only_the_service_role_may_call_it_and_0035s_form_is_kept(self):
        c = squash(code(TEXT))
        self.assertIn(f"revoke all on function public.record_model_probe({ELEVEN}) from public, anon, authenticated;", c)
        self.assertIn(f"grant execute on function public.record_model_probe({ELEVEN}) to service_role;", c)
        self.assertEqual(re.findall(r"grant execute on function [^;]+ to ([a-z_, ]+);", c), ["service_role"])
        self.assertIn("security definer set search_path = public, pg_temp", c)
        # Additive: nothing of 0035 is dropped or redefined.
        self.assertNotIn("drop function", c.lower())
        self.assertNotIn(f"record_model_probe({TEN})", c.split("do $$")[0])

    def test_it_touches_nothing_else(self):
        c = code(TEXT).lower()
        self.assertEqual(sorted(set(re.findall(r"alter table\s+([\w.]+)", c))), ["public.model_probe_runs"])
        for verb in ("create table", "drop table", "create policy", "drop policy", "insert into public.model_registry",
                     "delete from", "drop trigger", "update public.model_probe_runs"):
            self.assertNotIn(verb, c, verb)

    def test_the_file_is_live_on_apply_one_transaction_with_an_end_state_and_a_verify_block(self):
        self.assertIn("LIVE ON APPLY", TEXT)
        self.assertIn("APPLY AS ONE TRANSACTION", TEXT)
        self.assertIn("set local lock_timeout", code(TEXT))
        self.assertIn("raise exception '0152:", code(TEXT))
        self.assertIn("-- Verify", TEXT)

    def test_the_rollback_drops_only_what_0152_added(self):
        c = squash(code(ROLLBACK))
        self.assertIn(f"drop function if exists public.record_model_probe({ELEVEN});", c)
        self.assertNotIn(f"record_model_probe({TEN});", c)
        self.assertIn("drop column if exists vendor_credits", c)
        self.assertTrue(c.startswith("begin;") and c.endswith("commit;"))


class FakeResp:
    def __init__(self, status: int, data=None):
        self.status_code = status
        self._data = data

    def json(self):
        return self._data


class FakeHttp:
    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []

    def post(self, url, json=None, headers=None, timeout=None):  # noqa: A002 — requests' own name
        self.calls.append((url, json))
        return self.answers.pop(0)


def _record(db, credits):
    return db.record(model="runway-gen4.5", adapter="video.runway", vendor_model="gen4.5", capability="i2v", ok=True,
                     error_code=None, error=None, latency_ms=10, output_bytes=5, probed_by="t", vendor_credits=credits)


class Writer(unittest.TestCase):
    def db(self, *answers):
        from tools import probe_models

        http = FakeHttp(answers)
        return probe_models.RegistryDB("https://db.test", "service-key-not-real", session=http), http

    def test_a_reported_figure_goes_with_the_row(self):
        db, http = self.db(FakeResp(200, 41))
        self.assertEqual(_record(db, 60.0), 41)
        self.assertEqual(len(http.calls), 1)
        self.assertEqual(http.calls[0][1]["p_vendor_credits"], 60.0)

    def test_no_figure_is_never_sent_as_zero(self):
        db, http = self.db(FakeResp(200, 42))
        _record(db, None)
        self.assertNotIn("p_vendor_credits", http.calls[0][1])

    def test_a_figure_outside_0152s_rule_is_dropped_and_the_probe_still_recorded(self):
        for bad in (-1.0, 2_000_000.0):
            db, http = self.db(FakeResp(200, 43))
            _record(db, bad)
            self.assertNotIn("p_vendor_credits", http.calls[0][1])

    def test_without_0152_the_probe_is_recorded_once_through_0035s_form(self):
        db, http = self.db(FakeResp(404), FakeResp(200, 44))
        with self.assertLogs("probe_models", level="WARNING") as logs:
            self.assertEqual(_record(db, 25.0), 44)
        self.assertEqual([("p_vendor_credits" in p) for _, p in http.calls], [True, False])
        self.assertIn("apply migration 0152", "\n".join(logs.output))
        self.assertNotIn("service-key-not-real", "\n".join(logs.output))

    def test_any_other_refusal_is_not_retried(self):
        from tools import probe_models

        db, http = self.db(FakeResp(400))
        with self.assertRaises(probe_models.RpcError) as cm:
            _record(db, 25.0)
        self.assertEqual(cm.exception.status, 400)
        self.assertEqual(len(http.calls), 1)

    def test_the_cli_passes_the_vendors_figure_to_the_record(self):
        from tools import probe_models

        db = mock.Mock()
        ok = probe_models.ProbeResult("runway-gen4.5", True, latency_ms=10, output_bytes=5, credits=60.0)
        env = {"RUNWAYML_API_SECRET": "x", "SUPABASE_URL": "https://db.test", "SUPABASE_SERVICE_KEY": "y"}
        with mock.patch.object(probe_models, "run_probe", return_value=ok):
            code_ = probe_models.main(["--model", "runway-gen4.5", "--brief"], env=env, db=db, stream=io.StringIO())
        self.assertEqual(code_, 0)
        self.assertEqual(db.record.call_args.kwargs["vendor_credits"], 60.0)


if __name__ == "__main__":
    unittest.main()
