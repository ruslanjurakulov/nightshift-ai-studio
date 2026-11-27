"""tools/film_sweep.py (a pass, --loop, --check), FilmRest.sweep / sweep_status, .github/workflows/film_sweep_watchdog.yml, the
film-sweep service in deploy/docker-compose.yml, and the text of migration 0212 (switch-on gate G2).

What would break, and which test says so:

* the server's sweep not recorded under its own runner (`server`), or reported as done when it failed (a sweep that did not happen
  read as one is the "assumed, not measured" of CLAUDE.md rule 5);
* the service sweeping while its switch is off, dying on one failed pass, or not stopping on its event;
* the watchdog sweeping (it only reads), staying green while the database says overdue, or going red on "0212 not applied";
* GitHub Actions scheduled to sweep again (it is a watchdog, hourly);
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
import threading
import unittest
from pathlib import Path

import yaml

from modules import film_orchestrator as fo
from tools import film_sweep as fs

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "film_sweep_watchdog.yml"
COMPOSE = ROOT / "deploy" / "docker-compose.yml"
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

    def expire(self):  # must never be called: the server's runner always records
        self.calls.append(("expire",))
        return 0

    def sweep_status(self):
        self.calls.append(("status",))
        if self.exc:
            raise self.exc
        return self.result


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

    def test_one_recorded_sweep_as_server(self):
        db = FakeDb(result=2)
        rc, made, out = self.run_cli(ENV, db)
        self.assertEqual((rc, db.calls), (0, [("sweep", "server")]))
        self.assertEqual(made, [("https://x.supabase.co", KEY)])
        self.assertIn("2 segment(s)", out)

    def test_without_0212_it_fails_and_names_the_migration_and_never_sweeps_unrecorded(self):
        db = FakeDb(exc=fo.FilmFunctionMissing("film_sweep: HTTP 404 (migration 0212_film_sweep.sql is not applied)"))
        rc, _, out = self.run_cli(ENV, db)
        self.assertEqual((rc, db.calls), (1, [("sweep", "server")]))
        self.assertIn("0212", out)

    def test_a_failed_or_refused_sweep_fails_the_run(self):
        for exc, word in ((fo.FilmUnavailable("film_sweep: the sweep failed (55P03)"), "55P03"),
                          (fo.FilmUnavailable("film_sweep: ConnectionError"), "ConnectionError"),
                          (fo.FilmRefused("unknown_runner", "runner is one of"), "unknown_runner")):
            rc, _, out = self.run_cli(ENV, FakeDb(exc=exc))
            self.assertEqual(rc, 1, word)
            self.assertIn(word, out)


class Loop(unittest.TestCase):
    """--loop: the film-sweep service."""

    def run_loop(self, env, db, stop, passes_before_stop=None):
        orig = fs.one_pass
        calls = []

        def counting(d):
            calls.append(1)
            if passes_before_stop and len(calls) >= passes_before_stop:
                stop.set()
            return orig(d)

        fs.one_pass = counting
        try:
            with self.assertLogs("film_sweep", level=logging.INFO) as logs:
                rc = fs.main(env, argv=["--loop"], make_db=lambda u, k: db, stop=stop)
        finally:
            fs.one_pass = orig
        out = "\n".join(logs.output)
        self.assertNotIn(KEY, out)
        return rc, len(calls), out

    def test_off_unless_exactly_on_and_it_waits_for_the_stop_instead_of_exiting(self):
        for value in (None, "", "off", "ON", "true", "1"):
            env = dict(ENV)
            if value is not None:
                env[fs.SWITCH] = value
            stop = threading.Event()
            threading.Timer(0.05, stop.set).start()
            db = FakeDb()
            rc, passes, out = self.run_loop(env, db, stop)
            self.assertEqual((rc, passes, db.calls), (0, 0, []), value)
            self.assertIn("sweeps nothing", out)

    def test_without_the_service_key_it_sweeps_nothing_and_waits(self):
        stop = threading.Event()
        threading.Timer(0.05, stop.set).start()
        db = FakeDb()
        rc, passes, out = self.run_loop({fs.SWITCH: "on"}, db, stop)
        self.assertEqual((rc, passes, db.calls), (0, 0, []))
        self.assertIn("SUPABASE_SERVICE_KEY must be set", out)

    def test_it_sweeps_as_server_every_pass_survives_a_failure_and_stops_on_its_event(self):
        db = FakeDb(exc=fo.FilmUnavailable("film_sweep: HTTP 503"))
        stop = threading.Event()
        waits = []
        real_wait = stop.wait
        stop.wait = lambda t=None: (waits.append(t), real_wait(0))[1]
        rc, passes, out = self.run_loop({**ENV, fs.SWITCH: "on"}, db, stop, passes_before_stop=3)
        self.assertEqual((rc, passes), (0, 3))
        self.assertEqual(db.calls, [("sweep", "server")] * 3)
        self.assertEqual(waits[:2], [fs.EVERY_SECONDS, fs.EVERY_SECONDS])
        self.assertIn("HTTP 503", out)

    def test_a_crash_inside_a_pass_names_only_its_type(self):
        db = FakeDb(exc=ValueError(f"{KEY} https://x.supabase.co"))
        with self.assertLogs("film_sweep", level=logging.INFO) as logs:
            self.assertEqual(fs.one_pass(db), 1)
        self.assertNotIn(KEY, "\n".join(logs.output))
        self.assertIn("ValueError", "\n".join(logs.output))


class Check(unittest.TestCase):
    """--check: the hourly watchdog. It reads film_sweep_status() and never sweeps."""

    STATUS = {"runners": {}, "last_at": "2026-11-22T10:00:00+00:00", "open_segments": 2, "stuck_segments": 1,
              "oldest_stuck_minutes": 47, "overdue_after_minutes": 30, "overdue": True, "at": "2026-11-22T10:47:00+00:00"}

    def run_check(self, db, env=ENV):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = fs.main(env, argv=["--check"], make_db=lambda u, k: db)
        text = out.getvalue()
        self.assertNotIn(KEY, text)
        self.assertNotIn("x.supabase.co", text)
        self.assertFalse(any(c[0] in ("sweep", "expire") for c in db.calls), db.calls)  # it never sweeps
        return rc, text

    def test_overdue_is_red_and_names_the_stuck_counts(self):
        rc, text = self.run_check(FakeDb(result=self.STATUS))
        self.assertEqual(rc, 1)
        self.assertRegex(text, r"^::error title=Film sweep overdue::stuck_segments=1 oldest_stuck_minutes=47 ")

    def test_not_overdue_or_unknown_is_green_with_a_notice(self):
        for overdue, word in ((False, "not overdue"), (None, "unknown")):
            rc, text = self.run_check(FakeDb(result={**self.STATUS, "overdue": overdue, "stuck_segments": 0,
                                                     "oldest_stuck_minutes": None}))
            self.assertEqual(rc, 0, overdue)
            self.assertRegex(text, rf"^::notice title=Film sweep {word}.*::stuck_segments=0 oldest_stuck_minutes=unknown ")

    def test_0212_not_applied_is_one_neutral_notice(self):
        rc, text = self.run_check(FakeDb(exc=fo.FilmFunctionMissing("film_sweep_status: HTTP 404")))
        self.assertEqual(rc, 0)
        self.assertEqual(text.count("\n"), 1)
        self.assertTrue(text.startswith("::notice title=0212 not applied::"))

    def test_an_unreadable_status_is_red(self):
        for exc in (fo.FilmUnavailable("film_sweep_status: HTTP 503"), fo.FilmRefused("permission_denied")):
            rc, text = self.run_check(FakeDb(exc=exc))
            self.assertEqual(rc, 1)
            self.assertTrue(text.startswith("::error title=Film sweep status unreadable::"))
        rc, text = self.run_check(FakeDb(result=None))
        self.assertEqual(rc, 1)

    def test_secrets_unset_is_a_warning_and_green(self):
        rc, text = self.run_check(FakeDb(), env={})
        self.assertEqual(rc, 0)
        self.assertTrue(text.startswith("::warning title=Film sweep is off::"))

    def test_hostile_values_in_the_answer_never_reach_an_annotation(self):
        rc, text = self.run_check(FakeDb(result={**self.STATUS, "stuck_segments": "1\n::error::x", "last_at": "x" * 500}))
        self.assertEqual(rc, 1)
        self.assertEqual(text.count("\n"), 1)
        self.assertIn("stuck_segments=unknown", text)
        self.assertIn("last_at=never", text)

    def test_filmrest_sweep_status_reads_film_sweep_status_and_names_0212_when_missing(self):
        r, s = rest(Resp(200, self.STATUS))
        self.assertEqual(r.sweep_status(), self.STATUS)
        self.assertEqual(s.posts, [("https://x.supabase.co/rest/v1/rpc/film_sweep_status", {})])
        r, _ = rest(Resp(404, {}))
        with self.assertRaises(fo.FilmFunctionMissing) as e:
            r.sweep_status()
        self.assertIn("0212_film_sweep.sql", str(e.exception))


class Service(unittest.TestCase):
    def test_the_film_sweep_service_runs_the_loop_from_the_worker_image_and_env_file_without_a_key_flag(self):
        svc = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]["film-sweep"]
        self.assertEqual(svc["command"], ["python", "tools/film_sweep.py", "--loop"])
        self.assertEqual(svc["image"], yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]["film-worker"]["image"])
        self.assertEqual(svc["profiles"], ["worker"])
        self.assertIn(".env.worker", svc["env_file"][0]["path"])
        self.assertNotIn("SUPABASE_SERVICE_KEY", str(svc.get("environment", {})) + str(svc["command"]))
        self.assertEqual(svc["cap_drop"], ["ALL"])
        self.assertIn("no-new-privileges:true", svc["security_opt"])

    def test_the_deploy_starts_it_on_its_own_switch_not_the_film_workers(self):
        text = (ROOT / "deploy" / "remote-deploy.sh").read_text(encoding="utf-8")
        self.assertIn('if [[ "$line" == NIGHTSHIFT_FILM_SWEEP=on ]]; then filmsweep=on; fi', text)
        self.assertIn('if [[ "$filmsweep" == on ]]; then', text)
        self.assertIn("compose up -d --no-deps film-sweep", text)
        self.assertIn("NIGHTSHIFT_FILM_SWEEP=", (ROOT / "deploy" / ".env.worker.example").read_text(encoding="utf-8"))


class Workflow(unittest.TestCase):
    def setUp(self):
        self.doc = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_it_is_an_hourly_watchdog_and_nothing_in_actions_sweeps(self):
        on = self.doc.get("on", self.doc.get(True))  # YAML 1.1 reads a bare `on` as true
        self.assertEqual(on["schedule"], [{"cron": "17 * * * *"}])
        self.assertIn("workflow_dispatch", on)
        self.assertEqual(self.doc["concurrency"], {"group": "film-sweep-watchdog", "cancel-in-progress": False})
        self.assertFalse((ROOT / ".github" / "workflows" / "film_sweep.yml").exists())
        for wf in (ROOT / ".github" / "workflows").glob("*.yml"):
            body = wf.read_text(encoding="utf-8")
            for line in re.findall(r"python3? tools/film_sweep\.py[^\n]*", body):  # a run line, not a comment's mention
                self.assertEqual(line, "python tools/film_sweep.py --check", wf.name)
        self.assertIn("run: python tools/film_sweep.py --check", self.text)

    def test_least_privilege_and_pinned_actions(self):
        self.assertEqual(self.doc["permissions"], {"contents": "read"})
        steps = self.doc["jobs"]["watchdog"]["steps"]
        for step in steps:
            if "uses" in step:
                self.assertRegex(step["uses"], r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")
        checkout = [s for s in steps if str(s.get("uses", "")).startswith("actions/checkout@")]
        self.assertEqual(checkout[0]["with"]["persist-credentials"], False)

    def test_the_key_comes_from_secrets_only_and_it_runs_the_cli(self):
        step = [s for s in self.doc["jobs"]["watchdog"]["steps"] if s.get("name") == "Is the film sweep running?"][0]
        self.assertEqual(step["env"], {"SUPABASE_URL": "${{ secrets.SUPABASE_URL }}",
                                       "SUPABASE_SERVICE_KEY": "${{ secrets.SUPABASE_SERVICE_KEY }}"})
        self.assertEqual(step["run"], "python tools/film_sweep.py --check")
        self.assertIn("It spends nothing", self.text)


class MigrationText(unittest.TestCase):
    def setUp(self):
        self.sql = MIGRATION.read_text(encoding="utf-8")

    def test_the_pg_cron_job_runs_every_five_minutes_as_its_own_runner_and_is_unscheduled_first(self):
        self.assertIn("perform cron.unschedule('nightshift-film-sweep')", self.sql)
        self.assertIn("perform cron.schedule('nightshift-film-sweep', '*/5 * * * *',", self.sql)
        self.assertIn("from (select public.film_sweep(''pg_cron'') as r) s", self.sql)
        self.assertIn("raise notice '%', '0212: pg_cron is not enabled", self.sql)
        self.assertIn("Database -> Extensions -> pg_cron", self.sql)

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
