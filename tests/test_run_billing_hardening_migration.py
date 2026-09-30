"""supabase/migrations/0041_run_billing_hardening.sql — a paid queue run is paid
for, and for the length it runs (review findings C1, C2; roles audit (a), (b)).

The behaviour is attacked for real in tests/security/test_sec_run_billing.py
(Postgres 16, CI job `rls`). These pin the contract in the text, so a later
edit cannot quietly drop a clause the lab happens not to exercise:

* the insert policy is 0032's, verbatim, plus `api_hold_ref is null`;
* the payment guard is a BEFORE INSERT trigger (every writer, not just a
  browser), security definer with a pinned search_path, and not callable;
* it exempts the operator's org through 0020's own credits_exempt(), requires
  a hold otherwise, freezes the length into params.duration with 0017's
  bounds, and prices the floor the way modules/credits.minimum_reservation
  does;
* reserve_credits is not touched (0034 may change its internals);
* the file is idempotent and additive.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "supabase" / "migrations"
SQL = (MIGRATIONS / "0041_run_billing_hardening.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
P0032 = (MIGRATIONS / "0032_render_jobs_insert_params.sql").read_text()
P0032_CODE = "\n".join(line.split("--", 1)[0] for line in P0032.splitlines())
CREDITS_PY = (ROOT / "modules" / "credits.py").read_text()
CREDITS_TS = (ROOT / "command-center" / "lib" / "credits.ts").read_text()


def policy_body(code: str) -> str:
    m = re.search(r"create policy render_jobs_insert on public\.render_jobs(.*?)\);", code, re.S)
    assert m, "no render_jobs_insert policy"
    return re.sub(r"\s+", " ", m.group(1)).strip()


def function_body(name: str) -> str:
    m = re.search(rf"create or replace function public\.{name}\(\).*?\$\$(.*?)\$\$;", CODE, re.S)
    assert m, f"no function {name}"
    return m.group(1)


class InsertPolicy(unittest.TestCase):
    def test_is_0032s_policy_plus_no_api_hold(self):
        mine, theirs = policy_body(CODE), policy_body(P0032_CODE)
        self.assertEqual(mine.replace(" and api_hold_ref is null", ""), theirs)
        self.assertIn("and api_hold_ref is null", mine)

    def test_one_policy_dropped_then_created(self):
        self.assertEqual(len(re.findall(r"create policy \w+ on public\.render_jobs", CODE)), 1)
        self.assertIn("drop policy if exists render_jobs_insert on public.render_jobs;", CODE)


class PaymentGuard(unittest.TestCase):
    body = function_body("render_jobs_payment_guard")

    def test_is_a_before_insert_trigger_for_every_writer(self):
        self.assertRegex(CODE, r"create trigger render_jobs_payment_guard\s+before insert on public\.render_jobs\s+"
                               r"for each row execute function public\.render_jobs_payment_guard\(\);")
        self.assertIn("drop trigger if exists render_jobs_payment_guard on public.render_jobs;", CODE)

    def test_definer_with_pinned_search_path_and_not_callable(self):
        head = CODE.split("create or replace function public.render_jobs_payment_guard()", 1)[1].split("$$", 1)[0]
        self.assertIn("security definer", head)
        self.assertIn("set search_path = public, pg_temp", head)
        self.assertIn("revoke all on function public.render_jobs_payment_guard() from public, anon, authenticated;", CODE)

    def test_exempt_org_is_0020s_rule_and_returns_before_any_payment_check(self):
        exempt = self.body.index("public.credits_exempt(v_org)")
        self.assertLess(exempt, self.body.index("new.credit_ref is null and new.api_hold_ref is null"))
        self.assertLess(exempt, self.body.index("new.params :="))

    def test_a_customer_run_needs_exactly_one_hold(self):
        self.assertIn("if new.credit_ref is null and new.api_hold_ref is null then", self.body)
        self.assertIn("if new.credit_ref is not null and new.api_hold_ref is not null then", self.body)

    def test_the_credit_hold_is_an_open_unused_queue_hold_of_this_org(self):
        for clause in ("new.credit_ref !~ '^rj-'", "r.org_id is distinct from v_org", "r.status <> 'open'",
                       "r.started_at is not null", "r.created_at < now() - interval '3 hours'"):
            self.assertIn(clause, self.body)

    def test_the_api_hold_is_open_and_unbound(self):
        for clause in ("h.org_id is distinct from v_org", "h.status <> 'open'", "h.render_job_id is not null",
                       "h.download_request_id is not null"):
            self.assertIn(clause, self.body)

    def test_length_is_frozen_with_0017s_bounds(self):
        self.assertIn("least(greatest(round(v_secs), 30), 3600)", self.body)
        self.assertIn("jsonb_build_object('duration', v_secs::integer)", self.body)
        self.assertIn("target_duration_seconds", self.body)
        self.assertIn("not between 30 and 3600", (MIGRATIONS / "0029_publish_targets.sql").read_text())
        self.assertIn("MIN_RUN_SECONDS = 30", CREDITS_TS)
        self.assertIn("MAX_RUN_SECONDS = 3600", CREDITS_TS)

    def test_floor_is_minimum_reservation(self):
        # job_minimum flat, video_minute x (1 + margin) x minutes, rounded up.
        self.assertIn("where unit = 'job_minimum'", self.body)
        self.assertIn("vm.credits_per_unit * (1 + vm.margin) * v_secs / 60", self.body)
        self.assertIn("public.credits_round_up(v_need)", self.body)
        self.assertIn("prices[UNIT_JOB_MINIMUM].credits_per_unit", CREDITS_PY)
        self.assertIn("prices[UNIT_VIDEO_MINUTE].charge(d / 60.0)", CREDITS_PY)

    def test_an_outsider_gets_the_policys_refusal_first(self):
        first = self.body.index("accessible_channel_ids('admin')")
        self.assertLess(first, self.body.index("from public.channels"))
        self.assertLess(first, self.body.index("from public.credit_reservations"))


class TermsFrozen(unittest.TestCase):
    def test_paid_terms_cannot_change_after_insert(self):
        body = function_body("render_jobs_terms_frozen")
        for col in ("channel_id", "kind", "params", "credit_ref", "api_hold_ref", "requested_by"):
            self.assertIn(f"new.{col} is distinct from old.{col}", body)
        for col in ("status", "heartbeat_at", "attempts", "worker_id"):
            self.assertNotIn(f"new.{col}", body)
        self.assertRegex(CODE, r"create trigger render_jobs_terms_frozen\s+before update on public\.render_jobs")


class Additive(unittest.TestCase):
    def test_reserve_credits_and_0020_0031_functions_are_not_redefined(self):
        for fn in ("reserve_credits", "start_credit_reservation", "capture_credits", "release_credits",
                   "claim_render_job", "render_job_params_valid", "api_create_video"):
            self.assertNotIn(f"function public.{fn}(", CODE)

    def test_idempotent_and_nothing_dropped(self):
        self.assertNotRegex(CODE, r"(?i)drop (table|column|function)")
        self.assertEqual(len(re.findall(r"create trigger", CODE)), len(re.findall(r"drop trigger if exists", CODE)))
        self.assertEqual(len(re.findall(r"create function", CODE)), 0)

    def test_stops_with_the_remedy_and_ends_with_a_verify_block(self):
        for n in ("0017", "0018", "0020", "0031"):
            self.assertIn(f"apply {n}_", CODE)
        self.assertIn("-- Verify (run after applying; every column should read true)", SQL)


if __name__ == "__main__":
    unittest.main()
