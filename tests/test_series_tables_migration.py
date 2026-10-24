"""Migration 0120 (Series Factory S2), pinned from the file: what the security lab cannot see by running it.

* the two replaced functions are the repo's latest bodies (0029's render_job_params_valid, 0111's render_jobs_payment_guard) with only the
  marked additions, and the drift guard in the file carries exactly the md5 of those bodies;
* nothing is granted to an API role but SELECT on the tables; every function is revoked from every API role and granted narrowly;
* the migration is dormant: request_series_plan is granted to nobody, and nothing in the application calls any of its functions;
* the worker still refuses the new kind (it has no handler until slice S3), and the Python whitelist carries `series`.
"""

import hashlib
import re
import unittest
from pathlib import Path

from modules import run_request

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0120_series_tables.sql"
TEXT = FILE.read_text(encoding="utf-8")
ROLLBACK = ROOT / "docs" / "sql" / "rollback_0120_series_tables.sql"

RJPV = "create or replace function public.render_job_params_valid(p jsonb, p_kind text)"
GUARD = "create or replace function public.render_jobs_payment_guard() returns trigger"


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def body(sql: str, start: str) -> str:
    i = sql.index(start)
    a = sql.index("$$", i) + 2
    return sql[a:sql.index("$$", a)]


def h(b: str) -> str:
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


def read(name: str) -> str:
    return (MIG / name).read_text(encoding="utf-8")


def added_lines(old: str, new: str):
    """The lines of ``new`` that are not, in order, lines of ``old`` (a pure-addition diff); raises if anything of ``old`` was changed."""
    o, n = old.splitlines(), new.splitlines()
    out, i = [], 0
    for line in n:
        if i < len(o) and line == o[i]:
            i += 1
        else:
            out.append(line)
    assert i == len(o), f"line {i + 1} of the old body was changed or removed: {o[i]!r}"
    return out


class Numbering(unittest.TestCase):
    def test_the_number_is_unique_and_after_everything_that_was_merged_first(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0120"), 1)
        self.assertIn("0119", numbers)
        self.assertGreater("0120", "0119")
        self.assertNotIn("0118", numbers, "0118 is left unused: the file was renumbered to apply after 0119")

    def test_a_rollback_exists_and_is_one_transaction(self):
        rb = ROLLBACK.read_text(encoding="utf-8")
        self.assertRegex(rb, r"(?m)^begin;$")
        self.assertRegex(rb, r"(?m)^commit;$")

    def test_nothing_in_the_file_depends_on_0118_or_0119(self):
        c = code(TEXT)
        self.assertNotIn("0118", c)
        self.assertNotIn("0119", c)
        for name in ("channels_config_guard", "patch_channel_agent_config", "channel_spend_ceiling"):
            self.assertNotIn(name, c)


class ReplacedBodies(unittest.TestCase):
    def test_the_validator_is_0029s_body_plus_the_marked_blocks_only(self):
        old = body(read("0029_publish_targets.sql"), RJPV)
        new = body(TEXT, RJPV)
        # the allowed array line is the one line CHANGED, by one key: 'publish_hint'] -> 'publish_hint','series'] ; everything else is added
        self.assertEqual(old.count("'publish_hint'];"), 1)
        added = added_lines(old.replace("'publish_hint'];", "'publish_hint','series'];"), new)
        text = "\n".join(added)
        self.assertEqual(text.count("-- 0120:"), 2)
        self.assertIn("p ->> 'series' !~ '^[a-z0-9][a-z0-9._-]{0,63}$'", text)
        self.assertIn("p_kind = 'repair'", text)
        self.assertIn("if p_kind = 'series_plan' then", text)
        self.assertIn("(p - array['topic','niche','language','series']) = '{}'::jsonb", text)
        # nothing else about the old rules moved: still immutable plpgsql with the same declarations
        self.assertIn("language plpgsql immutable as", TEXT[TEXT.index(RJPV):TEXT.index(RJPV) + 200])

    def test_the_payment_guard_is_0111s_body_plus_one_marked_block(self):
        old = body(read("0111_video_safety.sql"), GUARD)
        new = body(TEXT, GUARD)
        added = added_lines(old, new)
        text = "\n".join(added)
        self.assertEqual(text.count("-- 0120:"), 1)
        self.assertIn("sp      public.series_plans;", text)
        self.assertIn("if new.series_plan_id is not null then", text)
        self.assertIn("raise exception 'render job refused: it is not the job its series plan queued'", text)
        # the block sits before everything the old body did, so an editor's planning job is not stopped by the admin-only check
        self.assertLess(new.index("new.series_plan_id is not null"), new.index("accessible_channel_ids('admin')"))
        # and it never returns early without having compared the job with its plan
        block = new[new.index("if new.series_plan_id is not null then"):new.index("select c.org_id, c.agent_config into v_org, v_cfg")]
        for needle in ("sp.id is null", "new.kind <> 'series_plan'", "sp.channel_id <> new.channel_id", "sp.status <> 'requested'",
                       "sp.render_job_id is not null", "new.credit_ref is not null", "new.api_hold_ref is not null",
                       "new.params ->> 'topic' is distinct from sp.topic", "new.params ->> 'niche' is distinct from sp.niche",
                       "new.params ->> 'language' is distinct from sp.language", "new.params ->> 'series' is distinct from sp.series_id",
                       "<> '{}'::jsonb"):
            self.assertIn(needle, block)

    def test_the_trigger_and_the_insert_policy_are_not_touched(self):
        c = code(TEXT)
        self.assertNotRegex(c, r"(?i)create trigger render_jobs_payment_guard")
        self.assertNotRegex(c, r"(?i)drop trigger if exists render_jobs_payment_guard")
        self.assertNotRegex(c, r"(?i)\bpolicy render_jobs_insert\b")
        self.assertNotIn("function public.render_jobs_terms_frozen", c)
        self.assertNotIn("audit_action_allowed", c)

    def test_the_drift_guard_carries_exactly_the_hashes_of_the_old_and_new_bodies(self):
        head = TEXT.split("1. Tables", 1)[0]
        want = {
            h(body(read("0029_publish_targets.sql"), RJPV)), h(body(TEXT, RJPV)),
            h(body(read("0111_video_safety.sql"), GUARD)), h(body(TEXT, GUARD)),
        }
        self.assertEqual(set(re.findall(r"'([0-9a-f]{32})'", code(head))), want)
        self.assertIn("v <> all (array[", head)
        self.assertIn("g <> all (array[", head)
        self.assertEqual(head.count("that is neither"), 2)
        self.assertLess(TEXT.index("0120 found a render_jobs_payment_guard"), TEXT.index(GUARD))
        self.assertLess(TEXT.index("0120 found a render_job_params_valid"), TEXT.index(RJPV))

    def test_the_old_bodies_are_the_latest_definitions_in_the_repo(self):
        for fn, header, expected in (("render_job_params_valid", RJPV, "0029_publish_targets.sql"),
                                     ("render_jobs_payment_guard", GUARD, "0111_video_safety.sql")):
            defs = [p.name for p in sorted(MIG.glob("*.sql")) if p.name < "0120" and f"create or replace function public.{fn}(" in p.read_text(encoding="utf-8")]
            self.assertEqual(defs[-1], expected, fn)

    def test_the_rollback_restores_the_old_bodies_byte_for_byte_and_guards_on_the_new_ones(self):
        rb = ROLLBACK.read_text(encoding="utf-8")
        self.assertEqual(body(rb, RJPV), body(read("0029_publish_targets.sql"), RJPV))
        self.assertEqual(body(rb, GUARD), body(read("0111_video_safety.sql"), GUARD))
        self.assertEqual(set(re.findall(r"'([0-9a-f]{32})'", code(rb))), {h(body(TEXT, RJPV)), h(body(TEXT, GUARD))})


class Privileges(unittest.TestCase):
    def test_nothing_is_granted_on_the_tables_but_select(self):
        c = code(TEXT)
        self.assertIn("revoke all on public.series_plans, public.series_episodes from public, anon, authenticated, service_role;", c)
        grants = re.findall(r"(?is)\bgrant\s+(.*?)\s+on\s+(?:table\s+)?public\.series_(?:plans|episodes)\b.*?to\s+([^;]*);", c)
        self.assertEqual([g[0].lower().strip() for g in grants], ["select"])
        self.assertEqual({r.strip() for r in grants[0][1].split(",")}, {"authenticated", "service_role"})
        self.assertNotRegex(c, r"(?i)\bgrant\s+(insert|update|delete|all|truncate)")

    def test_every_function_is_revoked_from_every_api_role_and_granted_narrowly(self):
        c = code(TEXT)
        created = set(re.findall(r"(?m)^create or replace function public\.(\w+)\(", c))
        revoked = set(re.findall(r"(?m)^revoke all on function public\.(\w+)\(", c))
        self.assertEqual(created - {"render_job_params_valid", "render_jobs_payment_guard"}, revoked - {"render_jobs_payment_guard"})
        for line in re.findall(r"(?m)^revoke all on function public\.(?!render_jobs_payment_guard)(.*)$", c):
            self.assertIn("from public, anon, authenticated, service_role;", line)
        grants = {m.group(1): m.group(2).strip() for m in re.finditer(r"(?m)^grant execute on function public\.(\w+)\([^)]*\) to ([^;]*);", c)}
        self.assertEqual(grants, {"finish_series_plan": "service_role", "quote_series_episode": "authenticated",
                                  "start_series_episode": "authenticated"})
        self.assertNotIn("anon", " ".join(grants.values()))

    def test_every_definer_pins_its_search_path(self):
        c = code(TEXT)
        for m in re.finditer(r"(?s)create or replace function public\.(\w+)\((.*?)\n\$\$;", c):
            head = m.group(0).split("$$", 1)[0]
            if "security definer" in head:
                self.assertIn("set search_path = public, pg_temp", head, m.group(1))

    def test_every_definer_that_writes_checks_the_caller(self):
        for name in ("request_series_plan", "quote_series_episode", "start_series_episode"):
            b = body(TEXT, f"create or replace function public.{name}(")
            self.assertIn("auth.uid()", b, name)
            self.assertIn("raise exception 'not_found' using errcode = 'P0002'", b, name)
        self.assertIn("credits_trusted_caller()", body(TEXT, "create or replace function public.finish_series_plan("))

    def test_a_cross_organization_answer_has_one_text(self):
        # not_found is raised with the same message for a missing row and another organization's row in all three user-facing functions
        for name, cond in (("request_series_plan", "ch.channel_id is null or ch.org_id is null or not public.is_org_member(ch.org_id)"),
                           ("quote_series_episode", "ep.id is null or not public.is_org_member(ep.org_id)"),
                           ("start_series_episode", "ep.id is null or not public.is_org_member(ep.org_id)")):
            b = body(TEXT, f"create or replace function public.{name}(")
            self.assertIn(f"if {cond} then\n    raise exception 'not_found' using errcode = 'P0002';", b, name)

    def test_start_prices_in_the_database_and_never_trusts_the_browsers_number(self):
        b = body(TEXT, "create or replace function public.start_series_episode(")
        self.assertIn("public.series_episode_price(ep.duration_s)", b)
        self.assertIn("round(p_max_credits, 2) <> v_price", b)
        self.assertIn("public.reserve_credits(ep.org_id, v_ref, v_price)", b, "the hold is the database's price, not p_max_credits")
        self.assertNotRegex(code(b), r"reserve_credits\([^)]*p_max_credits")
        self.assertIn("raise exception 'unpriced'", b)
        self.assertLess(b.index("raise exception 'unpriced'"), b.index("public.reserve_credits("))
        self.assertLess(b.index("perform public.credit_account_lock"), b.index("public.series_episode_blocker("), "the account is locked before the rows are judged")
        self.assertIn("p_idem is distinct from 'se:' || ep.id::text", b)
        self.assertIn("'rj-se-' || replace(ep.id::text, '-', '')", b)

    def test_the_price_formula_is_the_payment_guards(self):
        price = body(TEXT, "create or replace function public.series_episode_price(")
        guard = body(read("0111_video_safety.sql"), GUARD)
        self.assertIn("vm.credits_per_unit * (1 + vm.margin) * p_duration_s / 60", price)
        self.assertIn("vm.credits_per_unit * (1 + vm.margin) * v_secs / 60", guard)
        self.assertIn("greatest(coalesce(jm, 0)", price)
        self.assertIn("greatest(coalesce(jm, 0)", guard)


class Dormant(unittest.TestCase):
    NAMES = ("request_series_plan", "finish_series_plan", "quote_series_episode", "start_series_episode", "series_plan_daily_limit",
             "series_episode_price", "series_episode_blocker", "series_episode_json")

    def test_request_series_plan_is_granted_to_nobody(self):
        c = code(TEXT)
        self.assertNotRegex(c, r"grant execute on function public\.request_series_plan")
        self.assertIn("revoke all on function public.request_series_plan(", c)

    #: The files that wire the series tables and functions into the application (slice S3). Anything else naming one fails the test below.
    WIRED = {
        "modules/series_plan_worker.py",                                         # the worker: loads a plan, ends it (finish_series_plan)
        "tools/queue_worker.py",                                                 # hands a series_plan job to it (self.series_plans)
        "command-center/lib/seriesPlan.ts",                                      # pure logic and the closed words
        "command-center/lib/server/series-factory.ts",                           # the server flag
        "command-center/lib/server/seriesPlans.ts",                              # the reads: series_plans, series_episodes, quote_series_episode
        "command-center/components/series/PlanSeriesPanel.tsx",                  # request_series_plan (the "Plan a series" button)
        "command-center/components/series/SeriesPlanView.tsx",                   # start_series_episode (the "Start episode" button)
        "command-center/app/(app)/[channel]/series/page.tsx",                    # the flagged entry point
        "command-center/app/(app)/[channel]/series/[id]/page.tsx",               # the flagged plan page
    }

    def test_only_the_s3_files_name_the_functions_and_the_tables(self):
        needles = list(self.NAMES) + ["series_plans", "series_episodes", "series_plan_id"]
        roots = [ROOT / "modules", ROOT / "tools", ROOT / "main.py", ROOT / "command-center" / "app", ROOT / "command-center" / "lib",
                 ROOT / "command-center" / "components", ROOT / ".github" / "workflows"]
        hits = []
        for r in roots:
            files = [r] if r.is_file() else [p for p in r.rglob("*") if p.is_file() and p.suffix in (".py", ".ts", ".tsx", ".yml", ".yaml", ".json")
                                             and "node_modules" not in p.parts and ".next" not in p.parts]
            for p in files:
                text = p.read_text(encoding="utf-8", errors="ignore")
                for n in needles:
                    if re.search(rf"\b{n}\b", text):
                        hits.append((p.relative_to(ROOT).as_posix(), n))
        stray = sorted({f for f, _ in hits} - self.WIRED)
        self.assertEqual(stray, [], "a file that wires a series function or table must be added to WIRED on purpose")
        self.assertEqual([f for f in sorted(self.WIRED) if not (ROOT / f).is_file()], [], "WIRED names a file that does not exist")

    def test_each_database_function_is_called_from_exactly_one_place(self):
        def callers(name: str, pattern: str):
            out = set()
            for base in (ROOT / "modules", ROOT / "tools", ROOT / "command-center" / "app", ROOT / "command-center" / "lib",
                         ROOT / "command-center" / "components"):
                for p in base.rglob("*"):
                    if p.is_file() and p.suffix in (".py", ".ts", ".tsx") and "node_modules" not in p.parts:
                        if re.search(pattern.format(name=name), p.read_text(encoding="utf-8", errors="ignore")):
                            out.add(p.relative_to(ROOT).as_posix())
            return out

        # Called (an rpc / REST call carrying the name as a string literal), not merely mentioned in a comment.
        call = r"""["'/]{name}["']"""
        self.assertEqual(callers("request_series_plan", call), {"command-center/components/series/PlanSeriesPanel.tsx"})
        self.assertEqual(callers("start_series_episode", call), {"command-center/components/series/SeriesPlanView.tsx"})
        self.assertEqual(callers("quote_series_episode", call), {"command-center/lib/server/seriesPlans.ts"})
        self.assertEqual(callers("finish_series_plan", r"""[/"']{name}"""), {"modules/series_plan_worker.py"},
                         "the service-key function is the worker's and never reaches a browser bundle")

    def test_no_migration_grants_request_series_plan_to_anyone(self):
        """The grant is a separate owner decision (it lets customers spend the shared Gemini key); S3 ships no migration."""
        for path in sorted((ROOT / "supabase" / "migrations").glob("*.sql")):
            text = code(path.read_text(encoding="utf-8"))
            self.assertNotRegex(text, r"grant\s+execute\s+on\s+function\s+public\.request_series_plan", path.name)

    def test_the_worker_handles_the_planning_kind_itself_and_run_request_still_refuses_it(self):
        # The kind never becomes a run: run_request refuses it (so main.py cannot be started for one), and the queue worker handles it
        # before that call (modules/series_plan_worker.py; tests/test_series_plan_worker.py pins the behaviour).
        self.assertNotIn("series_plan", run_request.KINDS)
        with self.assertRaises(run_request.InvalidRunRequest):
            run_request.validate("news", "series_plan", {"topic": "t", "niche": "n"})
        with self.assertRaises(run_request.InvalidRunRequest):
            run_request.plan_run("news", "series_plan", {"topic": "t", "niche": "n"}, {})
        worker = (ROOT / "tools" / "queue_worker.py").read_text(encoding="utf-8")
        self.assertIn("series_plan_worker.KIND", worker)
        self.assertLess(worker.index("series_plan_worker.KIND"), worker.index("run_request.plan_run(channel_id"))

    def test_the_python_whitelist_matches_the_migrations_allowed_array(self):
        b = body(TEXT, RJPV)
        m = re.search(r"allowed text\[\] := array\[(.*?)\];", b, re.S)
        self.assertEqual(set(re.findall(r"'([a-z_]+)'", m.group(1))), set(run_request.ALLOWED_PARAMS) | set(run_request.HINT_PARAMS))
        self.assertIn("series", run_request.ALLOWED_PARAMS)


class Shape(unittest.TestCase):
    def test_both_tables_have_rls_and_a_member_read_policy_and_no_write_policy(self):
        c = code(TEXT)
        self.assertIn("alter table public.series_plans enable row level security;", c)
        self.assertIn("alter table public.series_episodes enable row level security;", c)
        self.assertEqual(sorted(re.findall(r"create policy (\w+) on public\.series_(?:plans|episodes)\s+for (\w+)", c)),
                         [("series_episodes_select", "select"), ("series_plans_select", "select")])

    def test_the_rows_are_never_deleted_and_their_terms_are_frozen(self):
        c = code(TEXT)
        for trg in ("series_plans_terms_frozen", "series_episodes_terms_frozen", "series_plans_no_delete", "series_episodes_no_delete"):
            self.assertIn(f"create trigger {trg}", c)

    def test_the_daily_cap_is_one_function(self):
        self.assertIn("select 5", body(TEXT, "create or replace function public.series_plan_daily_limit("))

    def test_additive_only(self):
        c = code(TEXT).lower()
        self.assertNotRegex(c, r"\bdrop table\b")
        self.assertNotRegex(c, r"\btruncate\b")
        self.assertNotRegex(c, r"\balter table [\w.]+ drop column\b")
        # no top-level statement rewrites or removes a row: data changes happen only inside the functions
        top = re.sub(r"(?s)\$\$.*?\$\$", "", c)
        self.assertNotRegex(top, r"(?im)^\s*(delete\s+from|update\s|insert\s+into|with\s)")


if __name__ == "__main__":
    unittest.main()
