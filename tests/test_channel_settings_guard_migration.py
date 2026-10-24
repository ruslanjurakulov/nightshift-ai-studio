"""Migration 0119 (a spend limit an editor cannot raise or remove; the card's settings written by one atomic function), read as text.

The behaviour (the lock against the shared fixture, the function, the concurrency, the replay and the rollback) is attacked in a real
database by tests/security/test_sec_channel_settings.py. This file pins what that cannot see without a database, on every laptop:

* the guard is 0117's body, character for character, with exactly one marked block added (house rule: never drop an earlier check);
* the two md5 values in the drift guard are those of 0117's body and of this file's own, and the rollback holds 0117's body;
* the SQL pattern for a number in text is the worker's (modules/channels._ASCII_NUMBER), digit for digit;
* patch_channel_agent_config runs as the CALLER (a definer function would run the UPDATE as the table owner, which the guard lets
  through), is one UPDATE, takes exactly the keys the page sends, and is granted to signed-in users only;
* nothing else changes: no table, no trigger, no policy, no grant on a table.
"""

import hashlib
import re
import unittest
from pathlib import Path

from modules import channels as worker

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0119_channel_settings_guard.sql"
TEXT = FILE.read_text(encoding="utf-8")
M117 = (MIG / "0117_voice_profiles.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0119_channel_settings_guard.sql").read_text(encoding="utf-8")


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0].rstrip() for line in sql.splitlines())


def function(sql: str, name: str) -> str:
    i = sql.index(f"create or replace function public.{name}")
    return sql[i:sql.index("\n$$;", i) + 4]


def md5_of_body(fn: str) -> str:
    body = fn[fn.index("$$") + 2:fn.rindex("$$")]
    return hashlib.md5(re.sub(r"\s+", " ", body).encode()).hexdigest()


GUARD_NEW = function(TEXT, "channels_config_guard()")
GUARD_OLD = function(M117, "channels_config_guard()")
PATCH = function(TEXT, "patch_channel_agent_config(")
HELPER = function(TEXT, "channel_spend_ceiling(")


class Numbering(unittest.TestCase):
    def test_the_number_is_unique_and_0118_is_not_taken_by_this_file(self):
        numbers = [p.name[:4] for p in MIG.glob("*.sql")]
        self.assertEqual(numbers.count("0119"), 1)
        self.assertTrue(FILE.name.startswith("0119_"))
        self.assertTrue(ROLLBACK.startswith("-- rollback_0119_channel_settings_guard.sql"))


class GuardIs0117PlusOneBlock(unittest.TestCase):
    def test_everything_outside_the_marked_block_is_0117s_text(self):
        block = re.search(r"  -- 0119: a monthly spend limit.*?\n  end;\n(?=  return new;)", GUARD_NEW, re.S)
        self.assertIsNotNone(block)
        self.assertEqual(GUARD_NEW.replace(block.group(0), ""), GUARD_OLD, "0117's text, character for character")

    def test_the_block_runs_after_the_browser_only_return_and_every_other_check(self):
        self.assertLess(GUARD_NEW.index("if current_user not in ('authenticated', 'anon')"), GUARD_NEW.index("spend_ceiling_lock"))
        self.assertLess(GUARD_NEW.index("hint = 'ai_disclosure_lock'"), GUARD_NEW.index("spend_ceiling_lock"))
        self.assertLess(GUARD_NEW.index("spend_ceiling_lock"), GUARD_NEW.rindex("return new;"))

    def test_the_rule_is_one_way_on_the_effective_limits_and_the_admin_check_is_the_controls(self):
        self.assertIn("old_cap double precision := public.channel_spend_ceiling(o -> 'spend_ceiling_usd');", GUARD_NEW)
        self.assertIn("new_cap := public.channel_spend_ceiling(n -> 'spend_ceiling_usd');", GUARD_NEW)
        self.assertIn("if old_cap is not null then", GUARD_NEW)
        self.assertIn("if (new_cap is null or new_cap > old_cap) and not public.is_org_member(org, 'admin') then", GUARD_NEW)
        self.assertIn("errcode = '42501', hint = 'spend_ceiling_lock'", GUARD_NEW)
        self.assertIn("raise exception 'spend_ceiling_lock:", GUARD_NEW)

    def test_the_trigger_is_not_dropped_or_recreated_and_the_guard_stays_an_invoker_function(self):
        c = code(TEXT)
        self.assertNotRegex(c, r"(?i)\b(drop|create)\s+trigger\b")
        self.assertNotIn("security definer", GUARD_NEW)
        self.assertIn("set search_path = public, pg_temp", GUARD_NEW)


class DriftGuard(unittest.TestCase):
    def test_the_hashes_in_the_file_are_0117s_body_and_its_own(self):
        head = code(TEXT.split("1. The limit a stored value means", 1)[0])
        found = set(re.findall(r"'([0-9a-f]{32})'", head))
        self.assertEqual(found, {md5_of_body(GUARD_OLD), md5_of_body(GUARD_NEW)})
        self.assertEqual(md5_of_body(GUARD_OLD), "b5cf70785cafdf71ec4cdc49bb393c9c", "0117's own list says the same")

    def test_the_check_runs_before_anything_is_replaced_and_raises(self):
        head = TEXT.split("1. The limit a stored value means", 1)[0]
        self.assertIn("g <> all (array[", head)
        self.assertIn("that is neither 0117", head)
        self.assertLess(TEXT.index("0119 found a channels_config_guard"), TEXT.index("create or replace function public.channels_config_guard()"))

    def test_the_rollback_holds_0117s_body_byte_for_byte_and_refuses_a_body_it_has_not_seen(self):
        self.assertEqual(function(ROLLBACK, "channels_config_guard()"), GUARD_OLD)
        found = set(re.findall(r"'([0-9a-f]{32})'", code(ROLLBACK.split("-- 0117's body.", 1)[0])))
        self.assertEqual(found, {md5_of_body(GUARD_OLD), md5_of_body(GUARD_NEW)})
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertRegex(ROLLBACK, r"(?m)^commit;$")
        self.assertIn("drop function if exists public.patch_channel_agent_config(text, jsonb);", ROLLBACK)
        self.assertIn("drop function if exists public.channel_spend_ceiling(jsonb);", ROLLBACK)
        self.assertNotRegex(code(ROLLBACK), r"(?i)\b(create|drop|alter)\s+trigger\b")


class TheHelperReadsTextTheWayTheWorkerDoes(unittest.TestCase):
    def test_the_pattern_is_the_workers_with_digits_spelled_out(self):
        sql_pattern = re.search(r"t !~ '(.*?)' then", HELPER).group(1)
        worker_pattern = worker._ASCII_NUMBER.pattern.replace(r"\d", "[0-9]")
        self.assertEqual(sql_pattern, "^" + worker_pattern + "$")
        self.assertTrue(worker._ASCII_NUMBER.flags & re.ASCII)

    def test_it_never_uses_a_locale_dependent_class(self):
        body = code(HELPER)
        for forbidden in (r"\d", r"\s", "[[:space:]]", "[[:digit:]]", "::numeric", "isfinite"):
            self.assertNotIn(forbidden, body.replace(r"\.", ""), forbidden)

    def test_only_a_json_number_or_string_can_be_a_limit_and_overflow_is_no_limit(self):
        self.assertIn("when 'number' then", HELPER)
        self.assertIn("when 'string' then", HELPER)
        self.assertIn("exception when numeric_value_out_of_range or invalid_text_representation then", HELPER)
        self.assertIn("f > 0 and f <> 'NaN'::double precision and f < 'Infinity'::double precision", HELPER)
        self.assertIn("immutable", HELPER.split("$$", 1)[0])


class ThePatchFunction(unittest.TestCase):
    def test_it_runs_as_the_caller_and_never_as_a_definer(self):
        header = PATCH.split("$$", 1)[0]
        self.assertIn("security invoker", header)
        self.assertNotIn("security definer", header)
        self.assertIn("set search_path = public, pg_temp", header)
        self.assertNotIn("security definer", code(PATCH))

    def test_it_is_one_update_and_nothing_else_writes(self):
        c = code(PATCH)
        self.assertEqual(len(re.findall(r"(?i)\bupdate\s+public\.channels\b", c)), 1)
        self.assertNotRegex(c, r"(?i)\b(insert|delete|truncate)\b")
        self.assertNotRegex(c, r"(?i)\bselect\b.*\bfrom\s+public\.channels\b")      # no read-then-write
        self.assertNotRegex(c, r"(?i)\bfor\s+(update|share)\b")                    # the UPDATE takes the row lock itself
        self.assertIn("returning c.agent_config into merged;", c)

    def test_the_merge_is_evaluated_inside_the_update_not_before_it(self):
        upd = code(PATCH)[code(PATCH).index("update public.channels c"):]
        self.assertIn("c.agent_config", upd.split("where", 1)[0])
        self.assertIn("|| sets) - drops", upd)

    def test_it_takes_exactly_the_keys_the_page_sends(self):
        keys = re.search(r"allowed constant text\[\] := array\[(.*?)\];", PATCH, re.S).group(1)
        sql_keys = set(re.findall(r"'(\w+)'", keys))
        ts = (ROOT / "command-center" / "lib" / "channelPatch.ts").read_text(encoding="utf-8")
        ts_keys = set(re.findall(r"^\s+(\w+)\?: ", ts.split("export type AgentConfigPatch = {", 1)[1].split("};", 1)[0], re.M))
        self.assertEqual(sql_keys, ts_keys)
        self.assertEqual(sql_keys, {"spend_ceiling_usd", "pinned_comment", "watch_next", "storyboard_review"})

    def test_none_of_the_other_controls_or_labels_can_be_named(self):
        keys = re.search(r"allowed constant text\[\] := array\[(.*?)\];", PATCH, re.S).group(1)
        for forbidden in ("auto_publish", "publish_gate", "require_two_person_publish", "ai_disclosure", "voice", "credential", "org_id", "status"):
            self.assertNotIn(forbidden, keys)

    def test_the_editor_check_is_in_the_update_and_the_refusal_is_the_one_the_page_maps(self):
        c = code(PATCH)
        self.assertIn("public.is_org_member(c.org_id, 'editor')", c)
        self.assertIn("raise exception 'channel not found or not yours' using errcode = '42501', hint = 'channel_not_writable';", c)
        self.assertIn("if auth.uid() is null then", c)
        self.assertEqual(c.count("hint = 'invalid_patch'"), c.count("raise exception 'invalid_patch"))

    def test_a_limit_through_it_is_a_json_number_the_worker_enforces_and_at_most_a_million(self):
        c = code(PATCH)
        self.assertIn("max_ceiling constant double precision := 1000000;", c)       # the page's MAX_SPEND_CEILING_USD
        self.assertIn("case when jsonb_typeof(v) = 'number' then public.channel_spend_ceiling(v) end", c)
        self.assertIn("if cap is null or cap > max_ceiling then", c)


class GrantsAndScope(unittest.TestCase):
    def test_the_grants(self):
        c = code(TEXT)
        self.assertIn("revoke all on function public.patch_channel_agent_config(text, jsonb) from public, anon, authenticated, service_role;", c)
        self.assertIn("grant execute on function public.patch_channel_agent_config(text, jsonb) to authenticated;", c)
        self.assertIn("revoke all on function public.channel_spend_ceiling(jsonb) from public, anon, authenticated, service_role;", c)
        self.assertIn("grant execute on function public.channel_spend_ceiling(jsonb) to authenticated, service_role;", c)
        self.assertIn("revoke all on function public.channels_config_guard() from public, anon, authenticated, service_role;", c)
        self.assertEqual(len(re.findall(r"(?i)\bgrant\b", c)), 2)

    def test_the_file_changes_three_functions_and_nothing_else(self):
        c = code(TEXT)
        self.assertEqual(sorted(re.findall(r"(?m)^create or replace function public\.(\w+)\(", c)),
                         ["channel_spend_ceiling", "channels_config_guard", "patch_channel_agent_config"])
        self.assertNotRegex(c, r"(?i)\b(create|alter|drop)\s+(table|policy|trigger|index|view|schema|extension|type)\b")
        self.assertNotRegex(c, r"(?i)\b(insert\s+into|delete\s+from|truncate)\b")
        self.assertEqual(len(re.findall(r"(?is)\bupdate\s+public\.channels\b", c)), 1)    # the function's, nothing at the top level

    def test_the_numbering_and_requirements_are_stated(self):
        self.assertIn("0118 is taken by the series-tables builder", TEXT)
        self.assertIn("Rollback: docs/sql/rollback_0119_channel_settings_guard.sql", TEXT)


if __name__ == "__main__":
    unittest.main()
