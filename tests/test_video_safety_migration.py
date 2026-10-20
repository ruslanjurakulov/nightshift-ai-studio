"""Migration 0111 (video safety: D8 no customer provider choice in the database, D12 a coded job error for the API and MCP,
D15 a pg_cron sweep of stale credit holds) is ADDITIVE and builds on the LATEST body of everything it redefines. These are the
checks that need no database: they read the file and fail if it ever drops a line of the old bodies, widens a grant, adds a
table, policy, trigger or audit action, lets its sentences drift from the Create page's, or if the rollback stops being the
exact old text. The behaviour (the refusal for every caller, the mapping for every error, the sweep beside a settlement, the
rollback and replay) is attacked in tests/security/test_sec_video_safety.py.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "supabase" / "migrations"
FILE = "0111_video_safety.sql"
SQL = (MIGRATIONS / FILE).read_text(encoding="utf-8")
ROLLBACK = (REPO / "docs" / "sql" / "rollback_0111_video_safety.sql").read_text(encoding="utf-8")

REPLACED = {"render_jobs_payment_guard": "0076_scene_regenerate.sql", "api_get_job": "0042_web_api_hardening.sql",
            "oauth_get_job": "0093_mcp_oauth.sql"}
NEW = {"render_job_public_error"}
CODES = ["credits", "voice", "provider_quota", "media", "render", "timeout", "held", "unknown"]
#: Codes the worker and the web app know that migration 0111's SQL helper does not yet list. `held` (the accuracy check
#: held the script before any video was made) arrived with a PR that may add no migration, so the public API and MCP
#: callers (api_get_job, oauth_get_job) read a `[code:held]` job as `unknown` until a follow-up migration adds it to
#: render_job_public_error. The web app's own mapping (parseJobError, create.jobError) already has it. Remove the code
#: from this tuple when that migration lands and the parity below must hold again.
SQL_PENDING = ("held",)


def code(text):
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines())


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def latest(name):
    """(file, body) of the newest migration BELOW this one that defines ``name``."""
    for f in sorted(MIGRATIONS.glob("*.sql"), reverse=True):
        if f.name >= FILE or not re.match(r"^\d{4}_", f.name):
            continue
        b = bodies(f.read_text(encoding="utf-8"))
        if name in b:
            return f.name, b[name]
    raise AssertionError(name)


CODE = code(SQL)
NEW_BODIES = bodies(SQL)


class BuiltOnTheLatestBodies(unittest.TestCase):
    def test_it_defines_exactly_the_three_functions_it_replaces_and_one_helper(self):
        self.assertEqual(sorted(NEW_BODIES), sorted([*REPLACED, *NEW]))
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)", CODE)), sorted([*REPLACED, *NEW]))

    def test_each_old_body_is_taken_from_the_file_that_last_defined_it(self):
        for name, src in REPLACED.items():
            self.assertEqual(latest(name)[0], src, name)
        for name in NEW:
            with self.assertRaises(AssertionError, msg=f"{name} existed before 0111"):
                latest(name)

    def test_the_payment_guard_is_0076s_body_plus_one_block_and_nothing_else(self):
        old, new = latest("render_jobs_payment_guard")[1], NEW_BODIES["render_jobs_payment_guard"]
        start = new.index("\n  -- 0111 (audit D8)")
        end = new.index("  end if;\n", start) + len("  end if;\n")
        block = new[start:end]
        # take the one block out and what is left is 0076's body, byte for byte
        self.assertEqual(new[:start] + new[end:], old)
        # it sits directly after the operator's early return
        self.assertTrue(new[:start].endswith("  if public.credits_exempt(v_org) then\n    return new;\n  end if;\n"))
        self.assertIn("nullif(btrim(new.params ->> 'video_provider'), '')", block)
        self.assertIn("nullif(btrim(new.params ->> 'image_provider'), '')", block)
        self.assertIn("errcode = '42501'", block)
        self.assertEqual(block.count("raise exception"), 1)

    def test_the_provider_check_is_after_the_operators_return_and_before_every_payment_check(self):
        guard = code(NEW_BODIES["render_jobs_payment_guard"])
        exempt = guard.index("if public.credits_exempt(v_org) then")
        refuse = guard.index("video_provider")
        self.assertLess(exempt, refuse)
        for later in ("new.credit_ref is null and new.api_hold_ref is null", "new.params := coalesce(", "from public.credit_reservations",
                      "from public.api_holds", "credits_round_up("):
            self.assertLess(refuse, guard.index(later), later)
        # the scene-regeneration link check (which runs for every organization) is above the operator's return, untouched
        self.assertLess(guard.index("new.scene_regeneration_id is not null"), exempt)
        # blank and null are tolerated: the test is on the trimmed, non-empty value only
        self.assertNotIn("is not null and new.params", guard)

    def test_the_payment_guard_keeps_every_statement_it_had(self):
        old, new = code(latest("render_jobs_payment_guard")[1]), code(NEW_BODIES["render_jobs_payment_guard"])
        for stmt in ("raise exception", "return new;", "credits_exempt(", "accessible_channel_ids('admin')", "is distinct from",
                     "credits_round_up(", "interval '3 hours'", "r.amount < v_need", "scene_regeneration_id"):
            self.assertGreaterEqual(new.count(stmt), old.count(stmt), stmt)
        self.assertEqual(new.count("raise exception"), old.count("raise exception") + 1)
        self.assertIn("security definer set search_path = public, pg_temp", new)

    def test_the_two_job_answers_are_the_old_bodies_with_only_the_error_line_replaced(self):
        for name in ("api_get_job", "oauth_get_job"):
            old, new = latest(name)[1], NEW_BODIES[name]
            self.assertEqual(old.count("'error', j.error,"), 1, name)
            self.assertEqual(new, old.replace(
                "'error', j.error,",
                "'error', public.render_job_public_error(j.status, j.error) -> 'error',\n"
                "      'error_code', public.render_job_public_error(j.status, j.error) -> 'error_code',"), name)

    def test_every_replaced_function_still_pins_its_search_path_and_is_a_definer(self):
        for name in REPLACED:
            head = NEW_BODIES[name].split("$$")[0]
            self.assertIn("security definer set search_path = public, pg_temp", head, name)


class TheJobErrorMapping(unittest.TestCase):
    helper = NEW_BODIES["render_job_public_error"]

    def test_the_prefix_rule_is_the_workers_and_the_typescript_layers(self):
        py = (REPO / "modules" / "render_error.py").read_text(encoding="utf-8")
        ts = (REPO / "command-center" / "lib" / "runBackend.ts").read_text(encoding="utf-8")
        self.assertIn(r'PREFIX_RE = re.compile(r"^\[code:([a-z_]+)\][ \t]?")', py)
        self.assertIn(r"/^\[code:([a-z_]+)\][ \t]?/.exec(error)", ts)
        self.assertIn(r"regexp_match(p_error, '^\[code:([a-z_]+)\][ \t]?')", self.helper)

    def test_the_code_list_is_the_closed_set_of_the_worker_and_of_typescript(self):
        py = (REPO / "modules" / "render_error.py").read_text(encoding="utf-8")
        ts = (REPO / "command-center" / "lib" / "runBackend.ts").read_text(encoding="utf-8")
        self.assertEqual(re.findall(r"\w+", re.search(r"JOB_ERROR_CODES = \[(.*?)\] as const", ts, re.S).group(1)), CODES)
        for c in CODES:
            self.assertRegex(py, rf'{c.upper()} = "{c}"')
        known = re.search(r"if v_code not in \((.*?)\) then", self.helper, re.S).group(1)
        self.assertEqual(re.findall(r"'(\w+)'", known),
                         [c for c in CODES[:-1] if c not in SQL_PENDING])   # unknown is the fall-through, not a listed code

    def test_the_sentences_are_the_create_pages_word_for_word(self):
        en = (REPO / "command-center" / "lib" / "i18n" / "en.ts").read_text(encoding="utf-8")
        block = re.search(r"jobError: \{(.*?)\n    \},", en, re.S).group(1)
        ts = dict(re.findall(r'(\w+): "([^"]*)",', block))
        self.assertEqual(sorted(ts), sorted(CODES))
        sql = dict(re.findall(r"when '(\w+)' then '([^']*)'", self.helper))
        sql["unknown"] = re.search(r"else '([^']*)'", self.helper).group(1)
        self.assertEqual(sql, {k: v for k, v in ts.items() if k not in SQL_PENDING})

    def test_only_a_failed_job_with_text_is_explained_and_the_rest_reads_null(self):
        self.assertRegex(self.helper, r"if p_status is distinct from 'failed' or p_error is null or p_error = '' then\s+"
                                       r"return jsonb_build_object\('error', null, 'error_code', null\);")

    def test_the_helper_reads_nothing_and_writes_nothing(self):
        head = self.helper.split("$$")[0]
        self.assertIn("immutable", head)
        self.assertNotIn("security definer", head)
        self.assertNotRegex(code(self.helper), r"\b(from|insert|update|delete)\b\s+public\.")

    def test_the_typescript_layer_passes_a_coded_answer_through(self):
        ops = (REPO / "command-center" / "lib" / "api" / "operations.ts").read_text(encoding="utf-8")
        body = ops.split("export function withPublicJobError", 1)[1].split("\n}\n", 1)[0]
        self.assertIn('if ("error_code" in data) return result;', body)
        self.assertLess(body.index('"error_code" in data'), body.index("parseJobError(raw)"))

    def test_nothing_in_the_application_calls_the_helper(self):
        skip = {"node_modules", ".next", "__pycache__", ".git"}
        users = []
        for root in ("command-center", "modules", "tools", "supabase/functions", ".github", "main.py"):
            base = REPO / root
            if not base.exists():
                continue
            for p in ([base] if base.is_file() else base.rglob("*")):
                if p.is_file() and not skip & set(p.parts) and p.suffix in (".ts", ".tsx", ".py", ".js", ".yml", ".yaml", ".json"):
                    if re.search(r"render_job_public_error[\"'(]", p.read_text(encoding="utf-8", errors="ignore")):    # a call, not a comment
                        users.append(str(p.relative_to(REPO)))
        self.assertEqual(users, [])


class AdditiveAndDormantSafe(unittest.TestCase):
    def test_it_creates_no_table_column_policy_trigger_index_constraint_or_extension_and_removes_nothing(self):
        self.assertIsNone(re.search(r"create table|create (unique )?index|create trigger|create policy|add column|drop column|"
                                    r"alter policy|drop policy|drop trigger|drop table|drop function|drop index|alter function|"
                                    r"alter table|add constraint|drop constraint|truncate|enable row level|disable row level|"
                                    r"create extension|create view|create schema", CODE, re.I))
        for stmt in (m.group(0) for m in re.finditer(r"^(?:update|delete|insert|truncate)\b[^;]*", CODE, re.M)):
            self.fail(f"a top-level statement writes data: {stmt[:80]}")
        self.assertRegex(CODE, r"(?m)^set local lock_timeout = '5s';")
        self.assertNotRegex(CODE, r"(?m)^set (?!local)")

    def test_it_does_not_touch_the_audit_list_or_any_money_function(self):
        self.assertNotIn("audit_action_allowed", CODE)
        for name in ("reserve_credits", "capture_credits", "release_credits", "start_credit_reservation", "credit_account_lock",
                     "credit_release_locked", "render_job_params_valid", "render_jobs_terms_frozen", "api_create_video",
                     "oauth_create_video", "claim_render_job"):
            self.assertNotRegex(CODE, rf"create or replace function public\.{name}\b", name)
        # and it calls the sweep only from its schedule text, never from a statement of its own
        self.assertEqual(CODE.count("expire_credit_reservations"), 3)      # the guard, the schedule, the command text
        self.assertNotRegex(CODE, r"(?m)^\s*(select|perform)\s+public\.expire_credit_reservations")

    def test_the_grants_are_the_old_ones_restated_and_the_helper_is_locked_to_everyone(self):
        revokes = re.findall(r"^revoke\s+all\s+on\s+function\s+public\.(\w+)\(([^)]*)\)\s+from\s+([a-z_, ]+);", CODE, re.M)
        self.assertEqual({(n, a, f.strip()) for n, a, f in revokes}, {
            ("render_jobs_payment_guard", "", "public, anon, authenticated"),
            ("render_job_public_error", "text, text", "public, anon, authenticated, service_role"),
            ("api_get_job", "text, bigint, text", "public, anon, authenticated, service_role"),
            ("oauth_get_job", "text, bigint, text", "public, anon, authenticated, service_role"),
        })
        grants = re.findall(r"^grant\s+(.*?)\s+on\s+function\s+public\.(\w+)\(([^)]*)\)\s+to\s+([a-z_, ]+);", CODE, re.M | re.S)
        self.assertEqual({(g[0], g[1], g[2], g[3].strip()) for g in grants},
                         {("execute", "api_get_job", "text, bigint, text", "anon"), ("execute", "oauth_get_job", "text, bigint, text", "anon")})
        # exactly what 0042 / 0093 / 0041 revoked and granted, so a replay leaves their ACLs alone
        self.assertIn("revoke all on function public.api_get_job(text, bigint, text) from public, anon, authenticated, service_role;",
                      (MIGRATIONS / REPLACED["api_get_job"]).read_text(encoding="utf-8"))
        self.assertIn("revoke all on function public.oauth_get_job(text, bigint, text) from public, anon, authenticated, service_role;",
                      (MIGRATIONS / REPLACED["oauth_get_job"]).read_text(encoding="utf-8"))
        self.assertIn("revoke all on function public.render_jobs_payment_guard() from public, anon, authenticated;",
                      (MIGRATIONS / "0041_run_billing_hardening.sql").read_text(encoding="utf-8"))
        self.assertNotRegex(CODE, r"grant [^;]*\bto\s+(public|authenticated|service_role)\b")

    def test_the_guards_name_only_what_earlier_migrations_made(self):
        for needle in ("to_regprocedure('public.render_jobs_payment_guard()') is null", "to_regprocedure('public.credits_exempt(uuid)') is null",
                       "to_regprocedure('public.credits_round_up(numeric)') is null", "to_regclass('public.render_jobs') is null",
                       "to_regclass('public.scene_regenerations') is null", "to_regprocedure('public.api_get_job(text, bigint, text)') is null",
                       "to_regprocedure('public.oauth_get_job(text, bigint, text)') is null",
                       "to_regprocedure('public.expire_credit_reservations(uuid, interval, interval)') is null"):
            self.assertIn(needle, CODE)
        self.assertIn("tgname = 'render_jobs_payment_guard'", CODE)      # the trigger the new check rides on must exist

    def test_the_applies_on_merge_warning_is_in_the_header(self):
        header = SQL.split("set local lock_timeout", 1)[0]
        self.assertIn("Merging it to main applies it", header)
        self.assertIn("DEPLOY ORDER", header)


class TheSweepSchedule(unittest.TestCase):
    def test_it_is_scheduled_only_when_pg_cron_is_there_and_replaces_itself(self):
        block = CODE[CODE.index("do $$\nbegin\n  if to_regprocedure('cron.schedule"):]
        self.assertIn("to_regprocedure('cron.schedule(text, text, text)') is not null", block)
        self.assertIn("to_regprocedure('cron.unschedule(text)') is not null", block)
        self.assertIn("to_regclass('cron.job') is not null", block)
        self.assertLess(block.index("perform cron.unschedule('nightshift-expire-credit-reservations');"),
                        block.index("perform cron.schedule('nightshift-expire-credit-reservations', '*/10 * * * *',"))
        self.assertIn("if exists (select 1 from cron.job where jobname = 'nightshift-expire-credit-reservations') then", block)
        self.assertIn("'select public.expire_credit_reservations()'", block)
        # a missing or failing pg_cron is a notice, never an error
        self.assertIn("exception when others then", block)
        self.assertEqual(block.count("raise notice"), 2)
        self.assertNotIn("raise exception", block)
        self.assertEqual(len(re.findall(r"perform cron\.schedule\(", CODE)), 1)

    def test_it_takes_the_defaults_of_the_function_and_names_a_job_of_its_own(self):
        self.assertNotIn("nightshift-expire-credit-lots", CODE)       # 0034's job is left alone
        src = (MIGRATIONS / "0020_credits.sql").read_text(encoding="utf-8")
        self.assertRegex(src, r"function public\.expire_credit_reservations\(\s+p_org uuid default null,\s+"
                              r"p_unstarted_after interval default interval '3 hours',\s+p_started_after interval default interval '24 hours'\s+\)")
        self.assertIn("if not public.credits_trusted_caller() then", src)         # pg_cron's session has no claims: trusted


class TheRollback(unittest.TestCase):
    def test_it_restores_each_function_to_the_text_it_had_before(self):
        rb = bodies(ROLLBACK)
        self.assertEqual(sorted(rb), sorted(REPLACED))
        for name in REPLACED:
            self.assertEqual(rb[name], latest(name)[1], name)

    def test_it_restores_the_grants_drops_the_helper_and_the_job_in_one_transaction(self):
        c = code(ROLLBACK)
        self.assertRegex(c, r"(?m)^begin;$")
        self.assertRegex(c, r"(?m)^commit;$")
        self.assertRegex(c, r"(?m)^set local lock_timeout = '5s';")
        self.assertIn("drop function if exists public.render_job_public_error(text, text);", c)
        for stmt in ("revoke all on function public.api_get_job(text, bigint, text) from public, anon, authenticated, service_role;",
                     "revoke all on function public.oauth_get_job(text, bigint, text) from public, anon, authenticated, service_role;",
                     "grant execute on function public.api_get_job(text, bigint, text) to anon;",
                     "grant execute on function public.oauth_get_job(text, bigint, text) to anon;",
                     "revoke all on function public.render_jobs_payment_guard() from public, anon, authenticated;"):
            self.assertIn(stmt, c)
        # the helper is dropped only AFTER the two functions that called it are put back
        self.assertGreater(c.index("drop function if exists public.render_job_public_error"), c.index("create or replace function public.oauth_get_job"))
        self.assertIn("perform cron.unschedule('nightshift-expire-credit-reservations');", c)
        self.assertNotRegex(c, r"(?im)^\s*(delete|truncate|drop table|update)\b")

    def test_it_warns_to_compare_before_running_it(self):
        self.assertIn("CHECK BEFORE YOU RUN IT", ROLLBACK)
        for fn in ("render_jobs_payment_guard()", "api_get_job(text, bigint, text)", "oauth_get_job(text, bigint, text)"):
            self.assertIn(f"pg_get_functiondef('public.{fn}'::regprocedure)", ROLLBACK)


class Documented(unittest.TestCase):
    def test_migrations_md_has_the_0111_section(self):
        doc = (REPO / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
        self.assertIn("(0111)", doc)
        section = doc.split("(0111)", 1)[1]
        for needle in ("Is it off?", "Undo.", "Replay.", "rollback_0111_video_safety.sql", "test_sec_video_safety.py"):
            self.assertIn(needle, section)


if __name__ == "__main__":
    unittest.main()
