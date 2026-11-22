"""tools/film_sweep.py, FilmRest.sweep, .github/workflows/film_sweep.yml and the text of migration 0212 (switch-on gate G2).

What would break, and which test says so:

* the Actions sweep not recorded under its own runner, or reported as done when it failed (a green run for a sweep that did not
  happen is the "assumed, not measured" of CLAUDE.md rule 5);
* the CLI quietly sweeping unrecorded where 0212 is missing, instead of failing and naming the migration;
* the service key, or a database message body, reaching the log;
* the workflow losing its schedule, its least-privilege token, its pinned actions, or taking the key from anywhere but secrets;
* 0212 losing its pg_cron job, its service-role-only grants, or the overdue rule's "unknown is null".
The behaviour in a real database is tests/security/test_sec_film_sweep_0212.py.
"""

from __future__ import annotations

import contextlib
import io
import logging
import re
import unittest
from pathlib import Path

import yaml

from modules import film_orchestrator as fo
from tools import film_sweep as fs

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "film_sweep.yml"
MIGRATION = ROOT / "supabase" / "migrations" / "0212_film_sweep.sql"
ROLLBACK = ROOT / "docs" / "sql" / "rollback_0212_film_sweep.sql"
KEY = "service-key-SECRET-0212-abcdef0123456789"
ENV = {"SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": KEY}


class Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class Session:
    def __init__(self, resp):
        self.resp = resp
        self.posts = []

    def post(self, url, json=None, timeout=None, headers=None):
        self.posts.append((url, json))
        return self.resp


def rest(resp):
    s = Session(resp)
    return fo.FilmRest("https://x.supabase.co", KEY, session=s), s


class FilmRestSweep(unittest.TestCase):
    def test_it_calls_film_sweep_with_the_runner_and_returns_what_it_settled(self):
        r, s = rest(Resp(200, {"ok": True, "runner": "actions", "settled": 3, "at": "2026-11-22T00:00:00Z"}))
        self.assertEqual(r.sweep("actions"), 3)
        self.assertEqual(s.posts, [("https://x.supabase.co/rest/v1/rpc/film_sweep", {"p_runner": "actions"})])

    def test_0212_missing_is_named(self):
        r, _ = rest(Resp(404, {"code": "PGRST202"}))
        with self.assertRaises(fo.FilmFunctionMissing) as e:
            r.sweep("actions")
        self.assertIn("0212_film_sweep.sql", str(e.exception))
        self.assertIsInstance(e.exception, fo.FilmUnavailable)  # every other caller still reads it as "unavailable"

    def test_a_failed_sweep_raises_with_its_sqlstate_only(self):
        r, _ = rest(Resp(200, {"ok": False, "runner": "actions", "error": "55P03", "at": "x"}))
        with self.assertRaises(fo.FilmUnavailable) as e:
            r.sweep("actions")
        self.assertIn("55P03", str(e.exception))
        for junk in ({"ok": False, "error": "segment 1234 of org acme: lock"}, None, [], {"ok": "true", "settled": 1}):
            r, _ = rest(Resp(200, junk))
            with self.assertRaises(fo.FilmUnavailable) as e:
                r.sweep("actions")
            self.assertNotIn("acme", str(e.exception))
            self.assertIn("no answer", str(e.exception))

    def test_an_answer_without_a_count_is_zero_never_a_made_up_number(self):
        for settled in (None, "3", True, 2.5):
            r, _ = rest(Resp(200, {"ok": True, "settled": settled}))
            self.assertEqual(r.sweep("worker"), 0, settled)

    def test_other_rpcs_keep_reading_a_404_as_unavailable(self):
        r, _ = rest(Resp(404, {}))
        with self.assertRaises(fo.FilmUnavailable):
            r.expire()


class FakeDb:
    def __init__(self, result=0, exc=None):
        self.result, self.exc, self.calls = result, exc, []

    def sweep(self, runner):
        self.calls.append(("sweep", runner))
        if self.exc:
            raise self.exc
        return self.result

    def expire(self):  # must never be called by the Actions runner
        self.calls.append(("expire",))
        return 0


class Cli(unittest.TestCase):
    def run_cli(self, env, db):
        made = []

        def make_db(url, key):
            made.append((url, key))
            return db

        with self.assertLogs("film_sweep", level=logging.INFO) as logs:
            rc = fs.main(env, make_db=make_db)
        out = "\n".join(logs.output)
        self.assertNotIn(KEY, out)
        return rc, made, out

    def test_without_the_secrets_it_is_off_and_exits_0(self):
        for env in ({}, {"SUPABASE_URL": "https://x.supabase.co"}, {"SUPABASE_SERVICE_KEY": KEY},
                    {"SUPABASE_URL": " ", "SUPABASE_SERVICE_KEY": KEY}):
            db = FakeDb()
            rc, made, out = self.run_cli(env, db)
            self.assertEqual((rc, made, db.calls), (0, [], []), env)
            self.assertIn("nothing was swept", out)

    def test_without_the_secrets_the_actions_page_gets_a_warning(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertLogs("film_sweep", level=logging.INFO):
            self.assertEqual(fs.main({}, make_db=lambda u, k: self.fail("no db without the secrets")), 0)
        self.assertRegex(out.getvalue(), r"^::warning title=Film sweep is off::.*not set")

    def test_one_recorded_sweep_as_actions(self):
        db = FakeDb(result=2)
        rc, made, out = self.run_cli(ENV, db)
        self.assertEqual((rc, db.calls), (0, [("sweep", "actions")]))
        self.assertEqual(made, [("https://x.supabase.co", KEY)])
        self.assertIn("2 segment(s)", out)

    def test_without_0212_it_fails_and_names_the_migration_and_never_sweeps_unrecorded(self):
        db = FakeDb(exc=fo.FilmFunctionMissing("film_sweep: HTTP 404 (migration 0212_film_sweep.sql is not applied)"))
        rc, _, out = self.run_cli(ENV, db)
        self.assertEqual((rc, db.calls), (1, [("sweep", "actions")]))
        self.assertIn("0212", out)

    def test_a_failed_or_refused_sweep_fails_the_run(self):
        for exc, word in ((fo.FilmUnavailable("film_sweep: the sweep failed (55P03)"), "55P03"),
                          (fo.FilmUnavailable("film_sweep: ConnectionError"), "ConnectionError"),
                          (fo.FilmRefused("unknown_runner", "runner is one of"), "unknown_runner")):
            rc, _, out = self.run_cli(ENV, FakeDb(exc=exc))
            self.assertEqual(rc, 1, word)
            self.assertIn(word, out)


class Workflow(unittest.TestCase):
    def setUp(self):
        self.doc = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_it_runs_every_ten_minutes_and_by_hand(self):
        on = self.doc.get("on", self.doc.get(True))  # YAML 1.1 reads a bare `on` as true
        self.assertEqual(on["schedule"], [{"cron": "3-59/10 * * * *"}])  # every 10 minutes, off the top of the hour
        self.assertIn("workflow_dispatch", on)
        self.assertEqual(self.doc["concurrency"], {"group": "film-sweep", "cancel-in-progress": False})

    def test_least_privilege_and_pinned_actions(self):
        self.assertEqual(self.doc["permissions"], {"contents": "read"})
        steps = self.doc["jobs"]["sweep"]["steps"]
        for step in steps:
            if "uses" in step:
                self.assertRegex(step["uses"], r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")
        checkout = [s for s in steps if str(s.get("uses", "")).startswith("actions/checkout@")]
        self.assertEqual(checkout[0]["with"]["persist-credentials"], False)

    def test_the_key_comes_from_secrets_only_and_it_runs_the_cli(self):
        step = [s for s in self.doc["jobs"]["sweep"]["steps"] if s.get("name") == "Film sweep"][0]
        self.assertEqual(step["env"], {"SUPABASE_URL": "${{ secrets.SUPABASE_URL }}",
                                       "SUPABASE_SERVICE_KEY": "${{ secrets.SUPABASE_SERVICE_KEY }}"})
        self.assertEqual(step["run"], "python tools/film_sweep.py")
        self.assertIn("It spends nothing", self.text)


class MigrationText(unittest.TestCase):
    def setUp(self):
        self.sql = MIGRATION.read_text(encoding="utf-8")

    def test_the_pg_cron_job_runs_every_five_minutes_as_its_own_runner_and_is_unscheduled_first(self):
        self.assertIn("perform cron.unschedule('nightshift-film-sweep')", self.sql)
        self.assertIn("perform cron.schedule('nightshift-film-sweep', '*/5 * * * *',", self.sql)
        self.assertIn("from (select public.film_sweep(''pg_cron'') as r) s", self.sql)
        self.assertIn("raise notice '0212: pg_cron is not enabled", self.sql)

    def test_pg_cron_never_marks_a_failed_sweep_succeeded(self):
        self.assertIn("''film_sweep failed with SQLSTATE '' || coalesce(r ->> ''error'', ''none''))::integer", self.sql)

    def test_a_schedule_that_did_not_land_is_not_a_notice(self):
        cron = self.sql[self.sql.index("-- 4. Every 5 minutes"):self.sql.index("-- 5. End state")]
        self.assertNotIn("exception when others", cron)
        self.assertIn("pg_cron is installed but the job nightshift-film-sweep is not this file''s", self.sql)

    def test_the_rollback_never_swallows_a_failed_unschedule(self):
        self.assertNotIn("exception when others", ROLLBACK.read_text(encoding="utf-8"))

    def test_the_header_says_a_cancelled_sweep_is_not_recorded(self):
        self.assertIn("57014", self.sql)
        self.assertIn("G2b", self.sql)

    def test_no_api_role_but_the_service_role_reaches_it(self):
        for fn in ("public.film_sweep(text)", "public.film_sweep_status()"):
            self.assertIn(f"revoke all on function {fn} from public, anon, authenticated, service_role;", self.sql)
            self.assertIn(f"grant execute on function {fn} to service_role;", self.sql)
        self.assertIn("revoke all on table public.film_sweep_runs from public, anon, authenticated, service_role;", self.sql)
        self.assertIn("grant select on table public.film_sweep_runs to service_role;", self.sql)
        self.assertNotRegex(self.sql, r"grant [^;]*film_sweep[^;]* to [^;]*(anon|authenticated)")

    def test_never_ran_is_null_not_fine_and_the_line_is_declared_once(self):
        self.assertIn("when not ever then null", self.sql)
        self.assertIn("'overdue', case when stuck_min > line then true", self.sql)
        self.assertEqual(len(re.findall(r"line\s+constant integer := 30;", self.sql)), 1)
        self.assertIn("'overdue_after_minutes', line,", self.sql)
        self.assertNotRegex(self.sql, r"interval '(20|30) minutes'")

    def test_0171_is_called_never_replaced(self):
        self.assertNotRegex(self.sql, r"create\s+or\s+replace\s+function\s+public\.film_expire_segments")
        self.assertIn("n := public.film_expire_segments();", self.sql)

    def test_the_drift_guard_and_the_rollback_pin_the_same_bodies(self):
        pins = set(re.findall(r"'(public\.film_sweep(?:_status)?\([^)]*\))', '([0-9a-f]{32})'", self.sql))
        self.assertEqual(len(pins), 2, pins)
        back = set(re.findall(r"'(public\.film_sweep(?:_status)?\([^)]*\))', '([0-9a-f]{32})'", ROLLBACK.read_text(encoding="utf-8")))
        self.assertEqual(pins, back)

    def test_it_ends_with_a_verify_block(self):
        self.assertIn("-- Verify (read-only", self.sql)


if __name__ == "__main__":
    unittest.main()
