"""Migration 0122 (the format-template carrier), pinned from the file: what the security lab cannot see by running it.

* the four replaced functions are 0120's bodies with only the marked additions, and the drift guard in the file carries exactly the md5 of the old
  and the new bodies (and the header names the same hashes, so the person who applies it reads what the file checks);
* it grants nothing: the new request_series_plan signature is revoked from every API role, the old one is dropped, and no migration grants either;
* the closed list of ids is the same in the CHECK, the request function, the params validator, the Python table and the TypeScript table;
* the rollback restores 0120's bodies byte for byte, restores the old signature revoked, and refuses while a format has been asked for;
* the Python whitelist of run parameters does NOT gain `template`: only a planning job carries it.
"""

import hashlib
import re
import unittest
from pathlib import Path

from modules import run_request
from modules import series_planner

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0122_series_template_carrier.sql"
TEXT = FILE.read_text(encoding="utf-8")
M0120 = (MIG / "0120_series_tables.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0122_series_template_carrier.sql").read_text(encoding="utf-8")

RJPV = "create or replace function public.render_job_params_valid(p jsonb, p_kind text)"
GUARD = "create or replace function public.render_jobs_payment_guard() returns trigger"
FROZEN = "create or replace function public.series_plans_terms_frozen()"
REQ = "create or replace function public.request_series_plan("
OLD_SIG = "public.request_series_plan(text, text, integer, text, integer, text, text)"
NEW_SIG = "public.request_series_plan(text, text, integer, text, integer, text, text, text)"
IDS = ("myth_vs_fact", "top5_countdown", "one_question_one_answer")


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def body(sql: str, start: str) -> str:
    i = sql.index(start)
    a = sql.index("$$", i) + 2
    return sql[a:sql.index("$$", a)]


def h(b: str) -> str:
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


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


def migrations_before(number: str):
    return sorted(p for p in MIG.glob("*.sql") if p.name[:4] < number)


class Numbering(unittest.TestCase):
    def test_the_number_is_unique_and_after_everything_that_was_merged_first(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0122"), 1)
        self.assertIn("0121", numbers)
        self.assertNotIn("0118", numbers)

    def test_the_rollback_exists_and_is_one_transaction(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertRegex(ROLLBACK, r"(?m)^commit;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)

    def test_the_file_says_it_is_applied_as_one_transaction_and_names_the_hashes_to_verify(self):
        self.assertIn("APPLY AS ONE TRANSACTION", TEXT)
        self.assertIn("WHAT TO VERIFY BEFORE YOU APPLY", TEXT)
        self.assertIn("set local lock_timeout", code(TEXT))


class ReplacedBodies(unittest.TestCase):
    def test_the_validator_is_0120s_body_plus_the_marked_lines_only(self):
        old, new = body(M0120, RJPV), body(TEXT, RJPV)
        self.assertEqual(old.count("'publish_hint','series'];"), 1)
        self.assertEqual(old.count("(p - array['topic','niche','language','series']) = '{}'::jsonb"), 1)
        self.assertEqual(old.count("  -- nothing a run takes (no length, provider, voice, resume or repair).\n"), 1)
        rewritten = (old.replace("'publish_hint','series'];", "'publish_hint','series','template'];")
                     .replace("(p - array['topic','niche','language','series']) = '{}'::jsonb",
                              "(p - array['topic','niche','language','series','template']) = '{}'::jsonb")
                     .replace("  -- nothing a run takes (no length, provider, voice, resume or repair).\n",
                              "  -- nothing a run takes (no length, provider, voice, resume or repair). 0122 adds the format it was asked for.\n"))
        added = "\n".join(added_lines(rewritten, new))
        self.assertEqual(added.count("-- 0122:"), 1)
        for needle in ("if p ? 'template' and (jsonb_typeof(p -> 'template') <> 'string'",
                       "or p ->> 'template' not in ('myth_vs_fact', 'top5_countdown', 'one_question_one_answer')",
                       "or p_kind is distinct from 'series_plan') then", "return false;"):
            self.assertIn(needle, added)
        self.assertNotIn("p_kind <> 'series_plan'", new, "a NULL kind must not slip past an unknown comparison")
        self.assertIn("language plpgsql immutable as", TEXT[TEXT.index(RJPV):TEXT.index(RJPV) + 200])

    def test_the_payment_guard_is_0120s_body_plus_two_lines_in_the_series_plan_block(self):
        old, new = body(M0120, GUARD), body(TEXT, GUARD)
        line = "       or (new.params - array['topic','niche','language','series']) <> '{}'::jsonb then"
        self.assertEqual(old.count(line), 1)
        added = added_lines(old.replace(line, line.replace("'series']", "'series','template']")), new)
        self.assertEqual(added, ["       -- 0122: the format on the job is the format the plan was asked for (both absent is fine; one of them alone is not)",
                                 "       or new.params ->> 'template' is distinct from sp.template_id"])
        block = new[new.index("if new.series_plan_id is not null then"):new.index("select c.org_id, c.agent_config into v_org, v_cfg")]
        for needle in ("new.params ->> 'template' is distinct from sp.template_id", "'series','template']) <> '{}'::jsonb",
                       "new.params ->> 'series' is distinct from sp.series_id", "sp.status <> 'requested'"):
            self.assertIn(needle, block)

    def test_the_frozen_trigger_function_gains_exactly_the_template_line(self):
        old, new = body(M0120, FROZEN), body(TEXT, FROZEN)
        self.assertEqual(added_lines(old, new), ["     -- 0122: the format is a term of the plan, as the topic is",
                                                  "     or new.template_id is distinct from old.template_id"])
        self.assertNotIn("create trigger", code(TEXT).lower(), "the trigger stays bound by create or replace")

    def test_request_series_plan_is_0120s_body_plus_the_marked_lines(self):
        old, new = body(M0120, REQ), body(TEXT, REQ)
        mid = (old.replace("""  v_hash := md5(jsonb_build_object('channel', ch.channel_id, 'topic', v_topic, 'n', p_n, 'language', v_lang,
                                   'duration', p_duration_s, 'series', v_series)::text);
""", """  v_hash := md5((jsonb_build_object('channel', ch.channel_id, 'topic', v_topic, 'n', p_n, 'language', v_lang,
                                    'duration', p_duration_s, 'series', v_series)
                 || case when p_template is null then '{}'::jsonb else jsonb_build_object('template', p_template) end)::text);
""").replace("""  insert into public.series_plans (id, org_id, channel_id, series_id, topic, niche, language, n_episodes, duration_s,
""", """  insert into public.series_plans (id, org_id, channel_id, series_id, topic, niche, language, n_episodes, duration_s, template_id,
""").replace("v_lang, p_n, p_duration_s, p_idem, v_hash, uid);", "v_lang, p_n, p_duration_s, p_template, p_idem, v_hash, uid);")
               .replace("""jsonb_strip_nulls(jsonb_build_object('topic', v_topic, 'niche', v_niche, 'language', v_lang, 'series', v_series)),""",
                        """jsonb_strip_nulls(jsonb_build_object('topic', v_topic, 'niche', v_niche, 'language', v_lang, 'series', v_series,
                                               'template', p_template)),""")
               .replace("  -- plan queued.\n", "  -- plan queued (0122: the format included; a NULL format is stripped, so the job then carries none).\n"))
        self.assertNotEqual(mid, old)
        added = "\n".join(added_lines(mid, new))
        self.assertIn("if p_template is not null and p_template not in ('myth_vs_fact', 'top5_countdown', 'one_question_one_answer') then", added)
        self.assertIn("raise exception 'invalid_template' using errcode = '22023';", added)
        self.assertEqual(added.count("-- 0122:"), 2)

    def test_the_signature_gains_one_defaulted_argument_and_nothing_else_about_the_header(self):
        head = TEXT[TEXT.index(REQ):TEXT.index(REQ) + 1000]
        self.assertIn("p_channel text, p_topic text, p_n integer, p_language text, p_duration_s integer, p_series text, p_idem text,\n  p_template text default null\n) returns jsonb", head)
        self.assertIn("language plpgsql volatile security definer set search_path = public, pg_temp as $$", head)

    def test_a_request_without_a_format_hashes_exactly_as_0120_did(self):
        b = body(TEXT, REQ)
        self.assertIn("|| case when p_template is null then '{}'::jsonb else jsonb_build_object('template', p_template) end", b)
        self.assertIn("jsonb_build_object('channel', ch.channel_id, 'topic', v_topic, 'n', p_n, 'language', v_lang,", b)
        self.assertIn("'duration', p_duration_s, 'series', v_series)", b)

    def test_the_format_is_validated_after_the_caller_is_known_and_before_anything_is_written(self):
        b = body(TEXT, REQ)
        self.assertLess(b.index("raise exception 'forbidden' using errcode = '42501';"), b.index("raise exception 'invalid_template'"))
        self.assertLess(b.index("raise exception 'invalid_template'"), b.index("pg_advisory_xact_lock"))
        self.assertLess(b.index("raise exception 'invalid_template'"), b.index("insert into public.series_plans"))
        self.assertNotRegex(code(b), r"p_template\s*:=|btrim\(\s*p_template|lower\(\s*p_template|coalesce\(\s*p_template",
                            "the format is never trimmed, lower-cased or defaulted")

    def test_the_drift_guard_carries_exactly_the_hashes_of_the_old_and_new_bodies(self):
        head = TEXT.split("1. The carrier", 1)[0]
        want = {h(body(M0120, RJPV)), h(body(TEXT, RJPV)), h(body(M0120, GUARD)), h(body(TEXT, GUARD)),
                h(body(M0120, FROZEN)), h(body(TEXT, FROZEN)), h(body(M0120, REQ)), h(body(TEXT, REQ))}
        self.assertEqual(len(want), 8)
        self.assertEqual(set(re.findall(r"'([0-9a-f]{32})'", code(head))), want)
        self.assertEqual(head.count("that is neither"), 3)
        self.assertLess(TEXT.index("0122 found a render_jobs_payment_guard"), TEXT.index(GUARD))
        self.assertLess(TEXT.index("0122 found a render_job_params_valid"), TEXT.index(RJPV))
        self.assertLess(TEXT.index("0122 found a series_plans_terms_frozen"), TEXT.index(FROZEN))
        self.assertLess(TEXT.index("0122 found a seven-argument request_series_plan"), TEXT.index(REQ))

    def test_the_header_names_the_before_and_after_hashes_the_applier_reads(self):
        header = TEXT.split("\nset local lock_timeout = ", 1)[0]
        for fn, old, new in (("render_job_params_valid", h(body(M0120, RJPV)), h(body(TEXT, RJPV))),
                             ("render_jobs_payment_guard", h(body(M0120, GUARD)), h(body(TEXT, GUARD))),
                             ("series_plans_terms_frozen", h(body(M0120, FROZEN)), h(body(TEXT, FROZEN)))):
            self.assertRegex(header, rf"--     {fn}\s+{old}\n", fn)
            self.assertRegex(header, rf"--     {fn}\s+{new}\n", fn)
        self.assertRegex(header, rf"--     request_series_plan \(7 args\) {h(body(M0120, REQ))}\n")
        self.assertRegex(header, rf"--     request_series_plan \(8 args\) {h(body(TEXT, REQ))}\n")

    def test_the_old_bodies_are_the_latest_definitions_in_the_repo(self):
        for fn in ("render_job_params_valid", "render_jobs_payment_guard", "series_plans_terms_frozen", "request_series_plan"):
            defs = [p.name for p in migrations_before("0122")
                    if re.search(rf"create or replace function public\.{fn}\(", p.read_text(encoding="utf-8"))]
            self.assertEqual(defs[-1], "0120_series_tables.sql", fn)

    def test_the_end_state_block_restates_the_pins_and_the_acl(self):
        end = TEXT[TEXT.index("5. The end state"):]
        for fn in (RJPV, GUARD, FROZEN, REQ):
            self.assertIn(h(body(TEXT, fn)), end)
        for needle in ("is still there", "executable by public or an API role", "aclexplode", "p.proacl is null", "a.grantee = 0"):
            self.assertIn(needle, end)


class WhatTheRollbackDoes(unittest.TestCase):
    def test_it_restores_0120s_bodies_byte_for_byte_and_guards_on_0122s(self):
        for fn in (RJPV, GUARD, FROZEN, REQ):
            self.assertEqual(body(ROLLBACK, fn), body(M0120, fn), fn)
        self.assertEqual(set(re.findall(r"'([0-9a-f]{32})'", code(ROLLBACK))),
                         {h(body(TEXT, RJPV)), h(body(TEXT, GUARD)), h(body(TEXT, FROZEN)), h(body(TEXT, REQ))})

    def test_the_old_signature_comes_back_revoked_and_the_new_one_goes(self):
        c = code(ROLLBACK)
        self.assertIn(f"revoke all on function {OLD_SIG} from public, anon, authenticated, service_role;", c)
        self.assertIn(f"drop function if exists {NEW_SIG};", c)
        self.assertNotRegex(c, r"(?i)\bgrant\b")
        self.assertLess(c.index(f"revoke all on function {OLD_SIG}"), c.index(f"drop function if exists {NEW_SIG}"))

    def test_the_bodies_go_back_before_the_column_goes(self):
        c = code(ROLLBACK)
        drop = c.index("drop column if exists template_id")
        for fn in (RJPV, GUARD, FROZEN):
            self.assertLess(c.index(fn), drop, "a trigger function that still names the column would fail on every update")

    def test_it_drops_the_check_and_the_column_in_that_order(self):
        c = code(ROLLBACK)
        self.assertIn("alter table public.series_plans drop constraint if exists series_plans_template_check;", c)
        self.assertLess(c.index("drop constraint if exists series_plans_template_check"), c.index("drop column if exists template_id"))

    def test_it_refuses_to_lose_a_record_or_to_leave_a_row_the_old_validator_would_refuse(self):
        self.assertIn("exists (select 1 from public.series_plans where template_id is not null)", ROLLBACK)
        self.assertIn("exists (select 1 from public.render_jobs where params ? 'template')", ROLLBACK)
        self.assertIn("a CHECK is evaluated again on every update", ROLLBACK)

    def test_it_touches_nothing_but_what_0122_added(self):
        c = re.sub(r"(?s)\$\$.*?\$\$", "", code(ROLLBACK).lower())      # statements outside the function bodies
        self.assertNotRegex(c, r"\bdrop table\b|\btruncate\b|\bdelete\s+from\b|\bupdate\s+public\.|\binsert\s+into\b")


class Privileges(unittest.TestCase):
    def test_nothing_is_granted_and_the_new_signature_is_revoked_from_every_api_role(self):
        c = code(TEXT)
        self.assertNotRegex(c, r"(?i)\bgrant\b")
        self.assertIn(f"revoke all on function {NEW_SIG} from public, anon, authenticated, service_role;", c)
        self.assertLess(c.index(REQ), c.index(f"revoke all on function {NEW_SIG}"))
        self.assertLess(c.index(f"revoke all on function {NEW_SIG}"), c.index(f"drop function if exists {OLD_SIG};"), "revoked before anything else happens")

    def test_the_only_function_dropped_is_the_old_signature_and_without_cascade(self):
        c = code(TEXT)
        self.assertEqual(re.findall(r"(?i)drop function[^;]*;", c), [f"drop function if exists {OLD_SIG};"])
        self.assertNotRegex(c, r"(?i)\bcascade\b")

    def test_the_old_signature_is_dropped_only_after_the_guard_proved_it_ungranted(self):
        guard = TEXT[TEXT.index("request_series_plan: the seven-argument function"):TEXT.index("1. The carrier")]
        for needle in ("p.proacl is null", "a.grantee = 0", "'anon', 'authenticated', 'service_role'", "executable by public or by an API role"):
            self.assertIn(needle, guard)
        self.assertLess(TEXT.index("a.grantee = 0"), TEXT.index(f"drop function if exists {OLD_SIG};"))

    def test_every_definer_pins_its_search_path(self):
        b = TEXT[TEXT.index(REQ):TEXT.index(REQ) + 1200]
        self.assertIn("security definer set search_path = public, pg_temp", b)
        g = TEXT[TEXT.index(GUARD):TEXT.index(GUARD) + 300]
        self.assertIn("security definer set search_path = public, pg_temp", g)

    def test_no_migration_grants_request_series_plan_in_either_signature(self):
        for path in sorted(MIG.glob("*.sql")):
            text = code(path.read_text(encoding="utf-8"))
            self.assertNotRegex(text, r"(?is)grant\s+execute\s+on\s+function\s+public\.request_series_plan", path.name)
            self.assertNotRegex(text, r"(?is)grant\s+all\s+on\s+function\s+public\.request_series_plan", path.name)

    def test_the_application_calls_the_function_from_one_place_and_only_with_a_format_when_one_was_picked(self):
        panel = (ROOT / "command-center" / "components" / "series" / "PlanSeriesPanel.tsx").read_text(encoding="utf-8")
        self.assertEqual(panel.count('"request_series_plan"'), 1)
        self.assertIn("...(chosen ? { p_template: chosen } : {})", panel)
        self.assertNotIn("p_template: null", panel)


class TheClosedList(unittest.TestCase):
    def test_the_same_three_ids_are_in_every_place_that_decides(self):
        self.assertEqual(tuple(series_planner.TEMPLATE_IDS), IDS)
        lists = re.findall(r"\(((?:'[a-z0-9_]+'(?:, )?)+)\)", code(TEXT))
        found = [tuple(re.findall(r"'([a-z0-9_]+)'", chunk)) for chunk in lists]
        in_ids = [f for f in found if set(f) <= set(IDS)]
        self.assertEqual(len(in_ids), 3, "the CHECK, the request function and the validator")
        for f in in_ids:
            self.assertEqual(f, IDS)

    def test_the_check_allows_null_and_the_three_words(self):
        self.assertIn("check (template_id is null or template_id in ('myth_vs_fact', 'top5_countdown', 'one_question_one_answer'));", code(TEXT))
        self.assertIn("alter table public.series_plans drop constraint if exists series_plans_template_check;", code(TEXT))

    def test_the_column_is_nullable_text_with_no_default(self):
        c = code(TEXT)
        self.assertIn("alter table public.series_plans add column if not exists template_id text;", c)
        self.assertNotRegex(c, r"template_id\s+text\s+(not null|default)")


class TheWhitelistOfRunParameters(unittest.TestCase):
    def test_the_database_allows_template_and_a_run_still_does_not(self):
        m = re.search(r"allowed text\[\] := array\[(.*?)\];", body(TEXT, RJPV), re.S)
        allowed = set(re.findall(r"'([a-z_]+)'", m.group(1)))
        self.assertEqual(allowed, set(run_request.ALLOWED_PARAMS) | set(run_request.HINT_PARAMS) | {"template"})
        self.assertNotIn("template", run_request.ALLOWED_PARAMS)
        self.assertNotIn("template", run_request.HINT_PARAMS)

    def test_a_run_request_carrying_a_template_is_refused_by_the_python_side_too(self):
        with self.assertRaises(run_request.InvalidRunRequest):
            run_request.validate("news", "daily", {"topic": "t", "template": "myth_vs_fact"})
        with self.assertRaises(run_request.InvalidRunRequest):
            run_request.plan_run("news", "series_plan", {"topic": "t", "niche": "n", "template": "myth_vs_fact"}, {})


class Shape(unittest.TestCase):
    def test_additive_only(self):
        c = code(TEXT).lower()
        self.assertNotRegex(c, r"\bdrop table\b")
        self.assertNotRegex(c, r"\btruncate\b")
        self.assertNotRegex(c, r"\balter table [\w.]+ drop column\b")
        top = re.sub(r"(?s)\$\$.*?\$\$", "", c)
        self.assertNotRegex(top, r"(?im)^\s*(delete\s+from|update\s|insert\s+into|with\s)")

    def test_the_only_altered_tables_are_series_plans_and_only_by_this_column_and_check(self):
        stmts = re.findall(r"(?is)alter table ([\w.]+) (.*?);", code(TEXT))
        self.assertEqual([t for t, _ in stmts], ["public.series_plans"] * 3)
        self.assertEqual(sorted(s.split()[0] + " " + s.split()[1] for _, s in stmts), ["add column", "add constraint", "drop constraint"])

    def test_it_does_not_touch_rls_policies_triggers_or_the_queue_kind(self):
        c = re.sub(r"(?s)\$\$.*?\$\$", "", code(TEXT).lower())
        for needle in ("create policy", "drop policy", "create trigger", "drop trigger", "render_jobs_kind_check", "enable row level security",
                       "credit_", "reserve_credits", "series_episodes (", "insert into"):
            self.assertNotIn(needle, c, needle)


if __name__ == "__main__":
    unittest.main()
